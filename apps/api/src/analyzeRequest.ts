import { analyzeTemplate, type AnalyzeTemplateOptions } from "@infralens/analyzer";
import type { AnalysisReport } from "@infralens/shared";

export type AnalyzeTemplateHandler = (
  rawTemplate: string,
  options?: AnalyzeTemplateOptions
) => AnalysisReport;

export type ApiErrorCode =
  | "MISSING_BODY"
  | "INVALID_TEMPLATE"
  | "ANALYSIS_ERROR"
  | "NOT_FOUND";

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    detail?: string;
  };
}

export interface AnalyzeApiRequest {
  template: string;
  sourceFiles?: Record<string, string>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly detail?: string
  ) {
    super(message);
  }
}

export function analyzeCloudFormationBody(
  rawBody: string | undefined,
  analyze: AnalyzeTemplateHandler = analyzeTemplate
): AnalysisReport {
  if (rawBody === undefined || rawBody.trim().length === 0) {
    throw new ApiRequestError(400, "MISSING_BODY", "Request body is required.");
  }

  const request = parseAnalyzeApiRequest(rawBody);

  try {
    return analyze(
      request.template,
      request.sourceFiles === undefined ? {} : { sourceFiles: request.sourceFiles }
    );
  } catch (error) {
    if (isInvalidTemplateError(error)) {
      throw new ApiRequestError(
        400,
        "INVALID_TEMPLATE",
        "Request body must be a valid CloudFormation template.",
        getErrorMessage(error)
      );
    }

    throw new ApiRequestError(
      500,
      "ANALYSIS_ERROR",
      "Template analysis failed unexpectedly.",
      getErrorMessage(error)
    );
  }
}

function parseAnalyzeApiRequest(rawBody: string): AnalyzeApiRequest {
  const parsedBody = tryParseJson(rawBody);

  if (!isRecord(parsedBody) || !("template" in parsedBody) || "Resources" in parsedBody) {
    return {
      template: rawBody
    };
  }

  if (typeof parsedBody.template !== "string" || parsedBody.template.trim().length === 0) {
    throw new ApiRequestError(
      400,
      "INVALID_TEMPLATE",
      "Request body must include a non-empty template string."
    );
  }

  const sourceFiles = parseSourceFiles(parsedBody.sourceFiles);

  return {
    template: parsedBody.template,
    ...(sourceFiles === undefined ? {} : { sourceFiles })
  };
}

function tryParseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function parseSourceFiles(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new ApiRequestError(
      400,
      "INVALID_TEMPLATE",
      "sourceFiles must be an object with file paths as keys and source code as values."
    );
  }

  const sourceFiles: Record<string, string> = {};

  for (const [filePath, sourceCode] of Object.entries(value)) {
    if (typeof sourceCode !== "string") {
      throw new ApiRequestError(
        400,
        "INVALID_TEMPLATE",
        "sourceFiles must be an object with file paths as keys and source code as values."
      );
    }

    sourceFiles[filePath] = sourceCode;
  }

  return sourceFiles;
}

export function toApiRequestError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) {
    return error;
  }

  return new ApiRequestError(500, "ANALYSIS_ERROR", "Unexpected API error.", getErrorMessage(error));
}

export function toApiErrorResponse(error: ApiRequestError): ApiErrorResponse {
  const payload: ApiErrorResponse = {
    error: {
      code: error.code,
      message: error.message
    }
  };

  if (error.detail !== undefined) {
    payload.error.detail = error.detail;
  }

  return payload;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInvalidTemplateError(error: unknown): boolean {
  return getErrorMessage(error).startsWith("Invalid CloudFormation");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
