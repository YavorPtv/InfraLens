import {
  analyzeTemplate,
  analyzeTemplateDiff,
  applyTemplateFixes,
  parseTemplateInput,
  type AnalyzeTemplateDiffOptions,
  type AnalyzeTemplateOptions
} from "@infralens/analyzer";
import type {
  AnalysisReport,
  ApplySuggestionsResult,
  CfnTemplate,
  DiffReport,
  TemplateFix,
  TemplatePatch,
  TemplatePathSegment
} from "@infralens/shared";

export type AnalyzeTemplateHandler = (
  rawTemplate: string,
  options?: AnalyzeTemplateOptions
) => AnalysisReport;

export type AnalyzeTemplateDiffHandler = (
  oldTemplate: string,
  newTemplate: string,
  options?: AnalyzeTemplateDiffOptions
) => DiffReport;

export type ApplyTemplateFixesHandler = (
  template: CfnTemplate,
  fixes: TemplateFix[]
) => ApplySuggestionsResult;

export type ApiErrorCode =
  | "MISSING_BODY"
  | "INVALID_TEMPLATE"
  | "INVALID_FIX"
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
  sourceFileExclusions?: string[];
}

export interface DiffApiRequest {
  oldTemplate: string;
  newTemplate: string;
}

export interface ApplyApiRequest {
  template: string;
  fixes: TemplateFix[];
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
      request.sourceFiles === undefined &&
        request.sourceFileMappings === undefined &&
        request.sourceFileExclusions === undefined
        ? {}
        : {
            ...(request.sourceFiles === undefined ? {} : { sourceFiles: request.sourceFiles }),
            ...(request.sourceFileMappings === undefined
              ? {}
              : { sourceFileMappings: request.sourceFileMappings }),
            ...(request.sourceFileExclusions === undefined
              ? {}
              : { sourceFileExclusions: request.sourceFileExclusions })
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

export function applyCloudFormationBody(
  rawBody: string | undefined,
  apply: ApplyTemplateFixesHandler = applyTemplateFixes
): ApplySuggestionsResult {
  if (rawBody === undefined || rawBody.trim().length === 0) {
    throw new ApiRequestError(400, "MISSING_BODY", "Request body is required.");
  }

  const request = parseApplyApiRequest(rawBody);

  try {
    return apply(parseTemplateInput(request.template), request.fixes);
  } catch (error) {
    if (isInvalidTemplateError(error)) {
      throw new ApiRequestError(
        400,
        "INVALID_TEMPLATE",
        "Request body must include a valid CloudFormation template.",
        getErrorMessage(error)
      );
    }

    throw new ApiRequestError(
      500,
      "ANALYSIS_ERROR",
      "Applying template suggestions failed unexpectedly.",
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
  const sourceFileExclusions = parseSourceFileExclusions(parsedBody.sourceFileExclusions);

  return {
    template: parsedBody.template,
    ...(sourceFiles === undefined ? {} : { sourceFiles }),
    ...(sourceFileMappings === undefined ? {} : { sourceFileMappings }),
    ...(sourceFileExclusions === undefined ? {} : { sourceFileExclusions })
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

function parseApplyApiRequest(rawBody: string): ApplyApiRequest {
  const parsedBody = tryParseJson(rawBody);

  if (!isRecord(parsedBody)) {
    throw new ApiRequestError(
      400,
      "INVALID_FIX",
      "Request body must be JSON with a template string and fixes array."
    );
  }

  if (typeof parsedBody.template !== "string" || parsedBody.template.trim().length === 0) {
    throw new ApiRequestError(
      400,
      "INVALID_TEMPLATE",
      "Request body must include a non-empty template string."
    );
  }

  if (!Array.isArray(parsedBody.fixes)) {
    throw new ApiRequestError(400, "INVALID_FIX", "Request body must include a fixes array.");
  }

  return {
    template: parsedBody.template,
    fixes: parsedBody.fixes.map(parseTemplateFix)
  };
}

function parseTemplateFix(value: unknown): TemplateFix {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.targetResourceId !== "string" ||
    typeof value.targetResourceType !== "string" ||
    (value.applicability !== "applicable" && value.applicability !== "manual-review") ||
    !isConfidence(value.confidence) ||
    typeof value.explanation !== "string" ||
    !isTemplateFixSource(value.source) ||
    !Array.isArray(value.patches)
  ) {
    throw invalidFixError();
  }

  return {
    id: value.id,
    title: value.title,
    targetResourceId: value.targetResourceId,
    targetResourceType: value.targetResourceType,
    applicability: value.applicability,
    confidence: value.confidence,
    explanation: value.explanation,
    source: value.source,
    patches: value.patches.map(parseTemplatePatch)
  };
}

function parseTemplatePatch(value: unknown): TemplatePatch {
  if (
    !isRecord(value) ||
    typeof value.targetResourceId !== "string" ||
    typeof value.targetResourceType !== "string" ||
    !Array.isArray(value.path) ||
    !value.path.every(isTemplatePathSegment) ||
    value.operation !== "set" ||
    !("value" in value) ||
    typeof value.allowCreate !== "boolean"
  ) {
    throw invalidFixError();
  }

  return {
    targetResourceId: value.targetResourceId,
    targetResourceType: value.targetResourceType,
    path: value.path,
    operation: "set",
    value: value.value as TemplatePatch["value"],
    allowCreate: value.allowCreate,
    ...("expectedValue" in value
      ? { expectedValue: value.expectedValue as TemplatePatch["expectedValue"] }
      : {})
  };
}

function isTemplateFixSource(value: unknown): value is TemplateFix["source"] {
  if (!isRecord(value) || typeof value.evidencePath !== "string") {
    return false;
  }

  return value.kind === "finding"
    ? typeof value.ruleId === "string"
    : value.kind === "least-privilege" &&
        typeof value.lambdaFunctionId === "string" &&
        typeof value.roleId === "string";
}

function isConfidence(value: unknown): value is TemplateFix["confidence"] {
  return value === "low" || value === "medium" || value === "high";
}

function isTemplatePathSegment(value: unknown): value is TemplatePathSegment {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

function invalidFixError(): ApiRequestError {
  return new ApiRequestError(400, "INVALID_FIX", "Each fix must be a valid structured template fix.");
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

function parseSourceFileExclusions(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ApiRequestError(
      400,
      "INVALID_TEMPLATE",
      "sourceFileExclusions must be an array of source file paths."
    );
  }

  const sourceFileExclusions: string[] = [];

  for (const filePath of value) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new ApiRequestError(
        400,
        "INVALID_TEMPLATE",
        "sourceFileExclusions must be an array of source file paths."
      );
    }

    sourceFileExclusions.push(filePath);
  }

  return sourceFileExclusions;
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
