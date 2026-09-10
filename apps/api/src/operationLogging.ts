import type {
  AnalysisReport,
  ApplySuggestionsResult,
  DiffReport
} from "@infralens/shared";
import { ApiRequestError } from "./analyzeRequest";

export type ApiOperation = "/analyze" | "/diff" | "/apply";
export type ApiOperationResult = AnalysisReport | DiffReport | ApplySuggestionsResult;

export interface ApiOperationLogEntry {
  event: "api_operation";
  operation: ApiOperation;
  requestId: string;
  outcome: "success" | "error";
  durationMs: number;
  sourceFileCount: number;
  resourceCount?: number;
  findingCount?: number;
  errorCategory?: string;
}

export type ApiLogWriter = (entry: ApiOperationLogEntry) => void;

export interface ExecuteLoggedOperationInput<T extends ApiOperationResult | Promise<ApiOperationResult>> {
  operation: ApiOperation;
  requestId: string;
  rawBody?: string;
  execute: () => T;
  writeLog?: ApiLogWriter;
  now?: () => number;
}

export function executeLoggedOperation<T extends ApiOperationResult | Promise<ApiOperationResult>>({
  operation,
  requestId,
  rawBody,
  execute,
  writeLog = writeStructuredLog,
  now = Date.now
}: ExecuteLoggedOperationInput<T>): T {
  const startedAt = now();
  const sourceFileCount = countSourceFiles(rawBody);

  function success(result: ApiOperationResult) {
    writeLog({ event: "api_operation", operation, requestId, outcome: "success",
      durationMs: Math.max(0, now() - startedAt), sourceFileCount, ...getResultMetrics(result) });
    return result;
  }
  function failure(error: unknown): never {
    writeLog({ event: "api_operation", operation, requestId, outcome: "error",
      durationMs: Math.max(0, now() - startedAt), sourceFileCount,
      errorCategory: error instanceof ApiRequestError ? error.code : "UNEXPECTED_ERROR" });
    throw error;
  }
  try {
    const result = execute();
    if (result instanceof Promise) return result.then(success, failure) as T;
    success(result);
    return result;
  } catch (error) { return failure(error); }
}

export function writeStructuredLog(entry: ApiOperationLogEntry): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function countSourceFiles(rawBody: string | undefined): number {
  if (rawBody === undefined) {
    return 0;
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.sourceFiles)) {
      return 0;
    }

    return Object.keys(parsed.sourceFiles).length;
  } catch {
    return 0;
  }
}

function getResultMetrics(result: ApiOperationResult): {
  resourceCount?: number;
  findingCount?: number;
} {
  if ("newReport" in result) {
    return {
      resourceCount: result.oldReport.resources.length + result.newReport.resources.length,
      findingCount: result.newReport.findings.length
    };
  }

  if ("resources" in result && "findings" in result) {
    return {
      resourceCount: result.resources.length,
      findingCount: result.findings.length
    };
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
