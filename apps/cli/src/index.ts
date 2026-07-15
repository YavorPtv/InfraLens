#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeTemplate } from "@infralens/analyzer";
import { formatAnalysisReport } from "./formatReport";

interface CliIo {
  stdout: {
    write: (message: string) => void;
  };
  stderr: {
    write: (message: string) => void;
  };
}

const usage = "Usage: npm run analyze -- [--json] <template.json>";

interface CliOptions {
  json: boolean;
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
    const output = options.json ? JSON.stringify(report, null, 2) : formatAnalysisReport(report);
    io.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`Error: Could not analyze CloudFormation template.\n${getErrorMessage(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false
  };

  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
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

  return options;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

if (require.main === module) {
  process.exitCode = main();
}
