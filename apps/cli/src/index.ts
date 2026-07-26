#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeTemplate } from "@infralens/analyzer";
import { exportAnalysisReportToJson, exportAnalysisReportToMarkdown } from "@infralens/shared";
import { formatAnalysisReport } from "./formatReport";

interface CliIo {
  stdout: {
    write: (message: string) => void;
  };
  stderr: {
    write: (message: string) => void;
  };
}

const usage =
  "Usage: npm run analyze -- [--json|--markdown] [--output <report.json|report.md>] <template.json|yaml|yml>";

interface CliOptions {
  json: boolean;
  markdown: boolean;
  outputPath?: string;
  templatePath?: string;
  error?: string;
}

export function main(argv: string[] = process.argv.slice(2), io: CliIo = process): number {
  const options = parseArgs(argv);

  if (options.error !== undefined) {
    io.stderr.write(`Error: ${options.error}\n${usage}\n`);
    return 1;
  }

  if (options.templatePath === undefined) {
    io.stderr.write(`Error: Missing CloudFormation template path.\n${usage}\n`);
    return 1;
  }

  const resolvedPath = resolve(options.templatePath);
  let rawTemplate: string;

  try {
    rawTemplate = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    io.stderr.write(`Error: Could not read template file at ${resolvedPath}.\n${getErrorMessage(error)}\n`);
    return 1;
  }

  try {
    const report = analyzeTemplate(rawTemplate);
    const output = formatOutput(report, options);

    if (options.outputPath !== undefined) {
      const resolvedOutputPath = resolve(options.outputPath);
      writeFileSync(resolvedOutputPath, `${output}\n`, "utf8");
      io.stdout.write(`Report written to ${resolvedOutputPath}\n`);
      return 0;
    }

    io.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`Error: Could not analyze CloudFormation template.\n${getErrorMessage(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    markdown: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--markdown") {
      options.markdown = true;
      continue;
    }

    if (arg === "--output") {
      const outputPath = argv[index + 1];

      if (outputPath === undefined || outputPath.startsWith("-")) {
        return {
          ...options,
          error: "--output requires a file path."
        };
      }

      options.outputPath = outputPath;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return {
        ...options,
        error: `Unknown option ${arg}.`
      };
    }

    if (options.templatePath !== undefined) {
      return {
        ...options,
        error: `Unexpected extra argument ${arg}.`
      };
    }

    options.templatePath = arg;
  }

  if (options.json && options.markdown) {
    return {
      ...options,
      error: "Choose either --json or --markdown, not both."
    };
  }

  return options;
}

function formatOutput(report: ReturnType<typeof analyzeTemplate>, options: CliOptions): string {
  if (options.json) {
    return exportAnalysisReportToJson(report);
  }

  if (options.markdown) {
    return exportAnalysisReportToMarkdown(report);
  }

  return formatAnalysisReport(report);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

if (require.main === module) {
  process.exitCode = main();
}
