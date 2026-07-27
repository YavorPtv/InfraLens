import {
  analyzeTemplate,
  analyzeTemplateDiff,
  type AnalyzeTemplateDiffOptions,
  type AnalyzeTemplateOptions
} from "@infralens/analyzer";
import type { AnalysisReport, DiffReport } from "@infralens/shared";

export type AnalyzeTemplateHandler = (
  rawTemplate: string,
  options?: AnalyzeTemplateOptions
) => AnalysisReport;

export type AnalyzeTemplateDiffHandler = (
  oldTemplate: string,
  newTemplate: string,
  options?: AnalyzeTemplateDiffOptions
) => DiffReport;

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
  sourceFileMappings?: Record<string, string>;
}

export interface DiffApiRequest {
  oldTemplate: string;
  newTemplate: string;
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
      request.sourceFiles === undefined && request.sourceFileMappings === undefined
        ? {}
        : {
            ...(request.sourceFiles === undefined ? {} : { sourceFiles: request.sourceFiles }),
            ...(request.sourceFileMappings === undefined
              ? {}
              : { sourceFileMappings: request.sourceFileMappings })
          }
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

export function diffCloudFormationBody(
  rawBody: string | undefined,
  diff: AnalyzeTemplateDiffHandler = analyzeTemplateDiff
): DiffReport {
  if (rawBody === undefined || rawBody.trim().length === 0) {
    throw new ApiRequestError(400, "MISSING_BODY", "Request body is required.");
  }

  const request = parseDiffApiRequest(rawBody);

  try {
    return diff(request.oldTemplate, request.newTemplate);
  } catch (error) {
    if (isInvalidTemplateError(error)) {
      throw new ApiRequestError(
        400,
        "INVALID_TEMPLATE",
        "Request body must include valid old and new CloudFormation templates.",
        getErrorMessage(error)
      );
    }

    throw new ApiRequestError(
      500,
      "ANALYSIS_ERROR",
      "Template diff analysis failed unexpectedly.",
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
  const sourceFileMappings = parseSourceFileMappings(parsedBody.sourceFileMappings);

  return {
    template: parsedBody.template,
    ...(sourceFiles === undefined ? {} : { sourceFiles }),
    ...(sourceFileMappings === undefined ? {} : { sourceFileMappings })
  };
}

function parseDiffApiRequest(rawBody: string): DiffApiRequest {
  const parsedBody = tryParseJson(rawBody);

  if (!isRecord(parsedBody)) {
    throw new ApiRequestError(
      400,
      "INVALID_TEMPLATE",
      "Request body must be JSON with oldTemplate and newTemplate strings."
    );
  }

  if (typeof parsedBody.oldTemplate !== "string" || parsedBody.oldTemplate.trim().length === 0) {
    throw new ApiRequestError(
      400,
      "INVALID_TEMPLATE",
      "Request body must include a non-empty oldTemplate string."
    );
  }

  if (typeof parsedBody.newTemplate !== "string" || parsedBody.newTemplate.trim().length === 0) {
    throw new ApiRequestError(
      400,
      "INVALID_TEMPLATE",
      "Request body must include a non-empty newTemplate string."
    );
  }

  return {
    oldTemplate: parsedBody.oldTemplate,
    newTemplate: parsedBody.newTemplate
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

function parseSourceFileMappings(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new ApiRequestError(
      400,
      "INVALID_TEMPLATE",
      "sourceFileMappings must be an object with source file paths as keys and Lambda logical ids as values."
    );
  }

  const sourceFileMappings: Record<string, string> = {};

  for (const [filePath, lambdaFunctionId] of Object.entries(value)) {
    if (typeof lambdaFunctionId !== "string" || lambdaFunctionId.trim().length === 0) {
      throw new ApiRequestError(
        400,
        "INVALID_TEMPLATE",
        "sourceFileMappings must be an object with source file paths as keys and Lambda logical ids as values."
      );
    }

    sourceFileMappings[filePath] = lambdaFunctionId;
  }

  return sourceFileMappings;
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
