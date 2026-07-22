import { analyzeTemplate } from "@infralens/analyzer";
import type { AnalysisReport } from "@infralens/shared";

export type AnalyzeTemplateHandler = (rawTemplateJson: string) => AnalysisReport;

export type ApiErrorCode =
  | "MISSING_BODY"
  | "INVALID_JSON"
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

  validateJson(rawBody);

  try {
    return analyze(rawBody);
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

function validateJson(rawBody: string): void {
  try {
    JSON.parse(rawBody);
  } catch (error) {
    throw new ApiRequestError(
      400,
      "INVALID_JSON",
      "Request body must be valid CloudFormation JSON.",
      getErrorMessage(error)
    );
  }
}

function isInvalidTemplateError(error: unknown): boolean {
  return getErrorMessage(error).startsWith("Invalid CloudFormation");
}
