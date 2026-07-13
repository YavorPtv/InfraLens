#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeTemplate } from "@infralens/analyzer";
import { formatAnalysisReport } from "./formatReport.js";

interface CliIo {
  stdout: {
    write: (message: string) => void;
  };
  stderr: {
    write: (message: string) => void;
  };
}

const usage = "Usage: npm run analyze -- <template.json>";

export function main(argv: string[] = process.argv.slice(2), io: CliIo = process): number {
  const templatePath = argv[0];

  if (templatePath === undefined) {
    io.stderr.write(`Error: Missing CloudFormation template path.\n${usage}\n`);
    return 1;
  }

  const resolvedPath = resolve(templatePath);
  let rawTemplate: string;

  try {
    rawTemplate = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    io.stderr.write(`Error: Could not read template file at ${resolvedPath}.\n${getErrorMessage(error)}\n`);
    return 1;
  }

  try {
    const report = analyzeTemplate(rawTemplate);
    io.stdout.write(`${formatAnalysisReport(report)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`Error: Could not analyze CloudFormation template.\n${getErrorMessage(error)}\n`);
    return 1;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

if (isDirectlyExecuted()) {
  process.exitCode = main();
}

function isDirectlyExecuted(): boolean {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}
