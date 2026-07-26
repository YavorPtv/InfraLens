#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeTemplate, analyzeTemplateDiff } from "@infralens/analyzer";
import {
  exportAnalysisReportToJson,
  exportAnalysisReportToMarkdown,
  exportDiffReportToMarkdown
} from "@infralens/shared";
import { formatDiffReport } from "./formatDiffReport";
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
  [
    "Usage:",
    "  npm run analyze -- [--json|--markdown] [--output <report.json|report.md>] <template.json|yaml|yml>",
    "  npm run analyze -- --diff [--json|--markdown] [--output <report.json|report.md>] <old-template.json|yaml|yml> <new-template.json|yaml|yml>",
    "  npm run diff -- [--json|--markdown] [--output <report.json|report.md>] <old-template.json|yaml|yml> <new-template.json|yaml|yml>"
  ].join("\n");

interface CliOptions {
  diff: boolean;
  json: boolean;
  markdown: boolean;
  outputPath?: string;
  templatePath?: string;
  oldTemplatePath?: string;
  newTemplatePath?: string;
  error?: string;
}

export function main(argv: string[] = process.argv.slice(2), io: CliIo = process): number {
  const options = parseArgs(argv);

  if (options.error !== undefined) {
    io.stderr.write(`Error: ${options.error}\n${usage}\n`);
    return 1;
  }

  if (options.diff) {
    return runDiff(options, io);
  }

  return runAnalysis(options, io);
}

function runAnalysis(options: CliOptions, io: CliIo): number {
  if (options.templatePath === undefined) {
    io.stderr.write(`Error: Missing CloudFormation template path.\n${usage}\n`);
    return 1;
  }

  const template = readTemplateFile(options.templatePath);

  if (!template.ok) {
    io.stderr.write(
      `Error: Could not read template file at ${template.resolvedPath}.\n${template.message}\n`
    );
    return 1;
  }

  try {
    const report = analyzeTemplate(template.contents);
    const output = formatAnalysisOutput(report, options);

    return writeOutput(output, options, io);
  } catch (error) {
    io.stderr.write(`Error: Could not analyze CloudFormation template.\n${getErrorMessage(error)}\n`);
    return 1;
  }
}

function runDiff(options: CliOptions, io: CliIo): number {
  if (options.oldTemplatePath === undefined || options.newTemplatePath === undefined) {
    io.stderr.write(
      `Error: Diff analysis requires old and new CloudFormation template paths.\n${usage}\n`
    );
    return 1;
  }

  const oldTemplate = readTemplateFile(options.oldTemplatePath);
  if (!oldTemplate.ok) {
    io.stderr.write(
      `Error: Could not read old template file at ${oldTemplate.resolvedPath}.\n${oldTemplate.message}\n`
    );
    return 1;
  }

  const newTemplate = readTemplateFile(options.newTemplatePath);
  if (!newTemplate.ok) {
    io.stderr.write(
      `Error: Could not read new template file at ${newTemplate.resolvedPath}.\n${newTemplate.message}\n`
    );
    return 1;
  }

  try {
    const report = analyzeTemplateDiff(oldTemplate.contents, newTemplate.contents);
    const output = formatDiffOutput(report, options);

    return writeOutput(output, options, io);
  } catch (error) {
    io.stderr.write(`Error: Could not compare CloudFormation templates.\n${getErrorMessage(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    diff: false,
    json: false,
    markdown: false
  };
  const positionalArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--diff") {
      options.diff = true;
      continue;
    }

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

    positionalArgs.push(arg);
  }

  if (options.json && options.markdown) {
    return {
      ...options,
      error: "Choose either --json or --markdown, not both."
    };
  }

  if (options.diff) {
    if (positionalArgs.length > 2) {
      return {
        ...options,
        error: `Unexpected extra argument ${positionalArgs[2]}.`
      };
    }

    return {
      ...options,
      oldTemplatePath: positionalArgs[0],
      newTemplatePath: positionalArgs[1]
    };
  }

  if (positionalArgs.length > 1) {
    return {
      ...options,
      error: `Unexpected extra argument ${positionalArgs[1]}.`
    };
  }

  return {
    ...options,
    templatePath: positionalArgs[0]
  };
}

function formatAnalysisOutput(
  report: ReturnType<typeof analyzeTemplate>,
  options: CliOptions
): string {
  if (options.json) {
    return exportAnalysisReportToJson(report);
  }

  if (options.markdown) {
    return exportAnalysisReportToMarkdown(report);
  }

  return formatAnalysisReport(report);
}

function formatDiffOutput(
  report: ReturnType<typeof analyzeTemplateDiff>,
  options: CliOptions
): string {
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }

  if (options.markdown) {
    return exportDiffReportToMarkdown(report);
  }

  return formatDiffReport(report);
}

function writeOutput(output: string, options: CliOptions, io: CliIo): number {
  if (options.outputPath !== undefined) {
    const resolvedOutputPath = resolve(options.outputPath);
    writeFileSync(resolvedOutputPath, `${output}\n`, "utf8");
    io.stdout.write(`Report written to ${resolvedOutputPath}\n`);
    return 0;
  }

  io.stdout.write(`${output}\n`);
  return 0;
}

function readTemplateFile(
  templatePath: string
):
  | { ok: true; contents: string; resolvedPath: string }
  | { ok: false; message: string; resolvedPath: string } {
  const resolvedPath = resolve(templatePath);

  try {
    return {
      ok: true,
      contents: readFileSync(resolvedPath, "utf8"),
      resolvedPath
    };
  } catch (error) {
    return {
      ok: false,
      message: getErrorMessage(error),
      resolvedPath
    };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

if (require.main === module) {
  process.exitCode = main();
}
