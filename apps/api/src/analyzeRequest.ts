import { validateWithCloudFormation, type CloudFormationTemplateValidator } from "./cloudFormationValidation";
import { getGeneratedTemplateStatus, type TemplateValidationResult, type AnalysisStatus } from "@infralens/shared";
import {
  analyzeTemplate,
  analyzeTemplateDiff,
  applyTemplateFixes,
  parseTemplateInput,
  validateTemplate,
  TemplateValidationError,
  type AnalyzeTemplateDiffOptions,
  type AnalyzeTemplateOptions
} from "@infralens/analyzer";
import type {
  AnalyzeApiRequest,
  AnalysisReport,
  ApplySuggestionsResult,
  CfnTemplate,
  DiffReport,
  TemplateFix,
  TemplatePatch,
  TemplatePathSegment
} from "@infralens/shared";
import { normalizeSourceAnalysisInput, normalizeSourceFilePath, SourcePathError } from "@infralens/shared";
export type { AnalyzeApiRequest } from "@infralens/shared";
import {
  defaultApiRequestLimits,
  type ApiRequestLimits
} from "./requestLimits";

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
  | "PAYLOAD_TOO_LARGE"
  | "ANALYSIS_ERROR"
  | "ANALYZER_INTERNAL_ERROR"
  | "NOT_FOUND";

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    detail?: string;
    validation?: TemplateValidationResult;
    analysisStatus?: AnalysisStatus;
  };
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
    readonly detail?: string,
    readonly validation?: TemplateValidationResult,
    readonly analysisStatus?: AnalysisStatus
  ) {
    super(message);
  }
}

export function analyzeCloudFormationBody(
  rawBody: string | undefined,
  analyze: AnalyzeTemplateHandler = analyzeTemplate,
  limits: ApiRequestLimits = defaultApiRequestLimits
): AnalysisReport {
  requireRequestBody(rawBody, limits);

  const request = parseAnalyzeApiRequest(rawBody, limits);
  const local = validateTemplate(request.template).validation;
  if (local.structure !== "valid") throw templateRequestError(new TemplateValidationError(local));

  try {
    const report = analyze(
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
    return { ...report, analysisStatus: "completed", validation: local };
  } catch (error) {
    if (error instanceof TemplateValidationError) throw templateRequestError(error);

    throw new ApiRequestError(
      500,
      "ANALYZER_INTERNAL_ERROR",
      "Template analysis failed unexpectedly.",
      undefined, local, "failed"
    );
  }
}

export function diffCloudFormationBody(
  rawBody: string | undefined,
  diff: AnalyzeTemplateDiffHandler = analyzeTemplateDiff,
  limits: ApiRequestLimits = defaultApiRequestLimits
): DiffReport {
  requireRequestBody(rawBody, limits);

  const request = parseDiffApiRequest(rawBody, limits);

  try {
    return diff(request.oldTemplate, request.newTemplate);
  } catch (error) {
    if (error instanceof TemplateValidationError) throw templateRequestError(error);

    throw new ApiRequestError(
      500,
      "ANALYSIS_ERROR",
      "Template diff analysis failed unexpectedly."
    );
  }
}

export function applyCloudFormationBody(
  rawBody: string | undefined,
  apply: ApplyTemplateFixesHandler = applyTemplateFixes,
  limits: ApiRequestLimits = defaultApiRequestLimits
): ApplySuggestionsResult {
  requireRequestBody(rawBody, limits);

  const request = parseApplyApiRequest(rawBody, limits);

  try {
    const original = parseTemplateInput(request.template);
    const result = apply(original, request.fixes);
    // Validate the actual returned artifact even for an injected/custom patch engine.
    const validation = validateTemplate(JSON.stringify(result.modifiedTemplate)).validation;
    const appliedIds = new Set(result.results.filter(r => r.status === "applied").map(r => r.fixId));
    for (const issue of validation.issues) {
      issue.relatedFixIds = request.fixes.filter(f => appliedIds.has(f.id) &&
        (!issue.path || issue.path === "Resources" || issue.path === "Resources." + f.targetResourceId ||
          issue.path.startsWith("Resources." + f.targetResourceId + "."))).map(f => f.id);
    }
    return { ...result, originalValidation: validateTemplate(request.template).validation,
      validation, generatedTemplateStatus: getGeneratedTemplateStatus(validation) };
  } catch (error) {
    if (error instanceof TemplateValidationError) throw templateRequestError(error);

    throw new ApiRequestError(
      500,
      "ANALYSIS_ERROR",
      "Applying template suggestions failed unexpectedly."
    );
  }
}

function parseAnalyzeApiRequest(
  rawBody: string,
  limits: ApiRequestLimits
): AnalyzeApiRequest {
  const parsedBody = tryParseJson(rawBody);

  if (!isRecord(parsedBody) || !("template" in parsedBody) || "Resources" in parsedBody) {
    assertByteLimit(rawBody, limits.maxTemplateBytes, "CloudFormation template");
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

  assertByteLimit(parsedBody.template, limits.maxTemplateBytes, "CloudFormation template");

  try {
    const sourceFiles = parseSourceFiles(parsedBody.sourceFiles, limits);
    const sourceFileMappings = parseSourceFileMappings(parsedBody.sourceFileMappings, limits);
    const sourceFileExclusions = parseSourceFileExclusions(parsedBody.sourceFileExclusions, limits);
    return {
      template: parsedBody.template,
      ...normalizeSourceAnalysisInput({ sourceFiles, sourceFileMappings, sourceFileExclusions })
    };
  } catch (error) {
    if (error instanceof SourcePathError) {
      throw new ApiRequestError(400, "INVALID_TEMPLATE", error.message);
    }
    throw error;
  }
}

function parseDiffApiRequest(rawBody: string, limits: ApiRequestLimits): DiffApiRequest {
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

  assertByteLimit(parsedBody.oldTemplate, limits.maxTemplateBytes, "Old CloudFormation template");
  assertByteLimit(parsedBody.newTemplate, limits.maxTemplateBytes, "New CloudFormation template");
  assertNumericLimit(
    byteLength(parsedBody.oldTemplate) + byteLength(parsedBody.newTemplate),
    limits.maxDiffTemplateBytes,
    "Combined diff template size"
  );

  return {
    oldTemplate: parsedBody.oldTemplate,
    newTemplate: parsedBody.newTemplate
  };
}

function parseApplyApiRequest(rawBody: string, limits: ApiRequestLimits): ApplyApiRequest {
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

  assertByteLimit(parsedBody.template, limits.maxTemplateBytes, "CloudFormation template");
  assertNumericLimit(parsedBody.fixes.length, limits.maxFixes, "Selected fix count");

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

function parseSourceFiles(
  value: unknown,
  limits: ApiRequestLimits
): Record<string, string> | undefined {
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

  const entries = Object.entries(value);
  assertNumericLimit(entries.length, limits.maxSourceFiles, "Source file count");

  const sourceFiles: Record<string, string> = Object.create(null);
  let combinedSourceBytes = 0;

  for (const [filePath, sourceCode] of entries) {
    if (typeof sourceCode !== "string") {
      throw new ApiRequestError(
        400,
        "INVALID_TEMPLATE",
        "sourceFiles must be an object with file paths as keys and source code as values."
      );
    }

    const normalizedPath = normalizeSourceFilePath(filePath);
    assertByteLimit(sourceCode, limits.maxSourceFileBytes, `Source file ${normalizedPath}`);
    combinedSourceBytes += byteLength(sourceCode);

    sourceFiles[filePath] = sourceCode;
  }

  assertNumericLimit(
    combinedSourceBytes,
    limits.maxCombinedSourceBytes,
    "Combined source-code size"
  );

  return sourceFiles;
}

function parseSourceFileMappings(
  value: unknown,
  limits: ApiRequestLimits
): Record<string, string> | undefined {
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

  const entries = Object.entries(value);
  assertNumericLimit(entries.length, limits.maxSourceMappings, "Source mapping count");

  const sourceFileMappings: Record<string, string> = Object.create(null);

  for (const [filePath, lambdaFunctionId] of entries) {
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

function parseSourceFileExclusions(
  value: unknown,
  limits: ApiRequestLimits
): string[] | undefined {
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

  assertNumericLimit(value.length, limits.maxSourceExclusions, "Source exclusion count");

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

  return new ApiRequestError(500, "ANALYSIS_ERROR", "Unexpected API error.");
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

  if (error.validation !== undefined) payload.error.validation = error.validation;
  if (error.analysisStatus !== undefined) payload.error.analysisStatus = error.analysisStatus;
  return payload;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireRequestBody(
  rawBody: string | undefined,
  limits: ApiRequestLimits
): asserts rawBody is string {
  if (rawBody === undefined || rawBody.trim().length === 0) {
    throw new ApiRequestError(400, "MISSING_BODY", "Request body is required.");
  }

  assertByteLimit(rawBody, limits.maxRequestBytes, "Request body");
}

function assertByteLimit(value: string, maximum: number, label: string): void {
  assertNumericLimit(byteLength(value), maximum, `${label} size`);
}

function assertNumericLimit(actual: number, maximum: number, label: string): void {
  if (actual <= maximum) {
    return;
  }

  throw new ApiRequestError(
    413,
    "PAYLOAD_TOO_LARGE",
    `${label} exceeds the configured limit of ${maximum}.`,
    `Received ${actual}.`
  );
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function templateRequestError(error: TemplateValidationError): ApiRequestError {
  return new ApiRequestError(400, "INVALID_TEMPLATE", "CloudFormation template validation failed.",
    error.message, error.validation, "not-run");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The transport adapters share these asynchronous validation steps.
export async function analyzeValidatedBody(rawBody: string | undefined, analyze: AnalyzeTemplateHandler | undefined,
  limits: ApiRequestLimits, validator?: CloudFormationTemplateValidator): Promise<AnalysisReport> {
  const report = analyzeCloudFormationBody(rawBody, analyze, limits);
  const request = parseAnalyzeApiRequest(rawBody!, limits);
  return { ...report, validation: await validateWithCloudFormation(request.template, report.validation, validator) };
}

export async function applyValidatedBody(rawBody: string | undefined, apply: ApplyTemplateFixesHandler | undefined,
  limits: ApiRequestLimits, validator?: CloudFormationTemplateValidator): Promise<ApplySuggestionsResult> {
  const result = applyCloudFormationBody(rawBody, apply, limits);
  const request = parseApplyApiRequest(rawBody!, limits);
  const [originalValidation, validation] = await Promise.all([
    validateWithCloudFormation(request.template, result.originalValidation, validator),
    validateWithCloudFormation(JSON.stringify(result.modifiedTemplate, null, 2) + "\n", result.validation, validator)
  ]);
  for (const issue of validation.issues.filter(i => i.stage === "cloudFormation" && i.severity === "error"))
    issue.relatedFixIds = result.results.filter(r => r.status === "applied").map(r => r.fixId);
  return { ...result, originalValidation, validation, generatedTemplateStatus: getGeneratedTemplateStatus(validation) };
}
