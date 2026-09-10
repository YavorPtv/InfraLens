import { configuredCloudFormationValidator, type CloudFormationTemplateValidator } from "./cloudFormationValidation";
import {
  analyzeValidatedBody,
  applyValidatedBody,
  diffCloudFormationBody,
  toApiErrorResponse,
  toApiRequestError,
  type AnalyzeTemplateDiffHandler,
  type AnalyzeTemplateHandler,
  type ApplyTemplateFixesHandler,
  type ApiErrorResponse
} from "./analyzeRequest";
import { getAllowedOrigins, getCorsResponseHeaders } from "./corsConfig";
import {
  executeLoggedOperation,
  type ApiLogWriter,
  type ApiOperation
} from "./operationLogging";
import { getApiRequestLimits, type ApiRequestLimits } from "./requestLimits";

export interface ApiGatewayAnalyzeRequest {
  body?: string | null;
  httpMethod?: string;
  path?: string;
  rawPath?: string;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    http?: {
      method?: string;
      path?: string;
    };
  };
  headers?: Record<string, string | undefined>;
}

export interface ApiGatewayAnalyzeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface CreateAnalyzeLambdaHandlerOptions {
  cloudFormationValidator?: CloudFormationTemplateValidator;
  analyze?: AnalyzeTemplateHandler;
  diff?: AnalyzeTemplateDiffHandler;
  apply?: ApplyTemplateFixesHandler;
  allowedOrigins?: string[];
  requestLimits?: ApiRequestLimits;
  writeLog?: ApiLogWriter;
}

export type AnalyzeLambdaHandler = (
  event: ApiGatewayAnalyzeRequest
) => Promise<ApiGatewayAnalyzeResponse>;

export function createAnalyzeLambdaHandler(
  options: CreateAnalyzeLambdaHandlerOptions = {}
): AnalyzeLambdaHandler {
  const validator = options.cloudFormationValidator;
  const analyze = options.analyze;
  const diff = options.diff;
  const apply = options.apply;
  const allowedOrigins = options.allowedOrigins ?? getAllowedOrigins();
  const requestLimits = options.requestLimits ?? getApiRequestLimits();

  return async function analyzeLambdaHandler(event) {
    const responseHeaders = {
      "content-type": "application/json",
      ...getCorsResponseHeaders(getRequestOrigin(event), allowedOrigins)
    };

    if (getHttpMethod(event) !== "POST") {
      return jsonResponse(405, responseHeaders, {
        error: {
          code: "NOT_FOUND",
          message: "Use POST /analyze, POST /diff, or POST /apply."
        }
      });
    }

    const operation = getOperation(event);
    if (operation === undefined) {
      return jsonResponse(404, responseHeaders, {
        error: {
          code: "NOT_FOUND",
          message: "Use POST /analyze, POST /diff, or POST /apply."
        }
      });
    }

    const requestId = event.requestContext?.requestId ?? "unavailable";

    try {
      const rawBody = decodeRequestBody(event);
      const result = await executeLoggedOperation({
        operation,
        requestId,
        rawBody,
        execute: () => executeOperation(operation, rawBody),
        ...(options.writeLog === undefined ? {} : { writeLog: options.writeLog })
      });
      return jsonResponse(200, responseHeaders, result);
    } catch (error) {
      const apiError = toApiRequestError(error);
      return jsonResponse(apiError.statusCode, responseHeaders, toApiErrorResponse(apiError));
    }

    function executeOperation(operation: ApiOperation, rawBody: string | undefined) {
      if (operation === "/diff") {
        return diffCloudFormationBody(rawBody, diff, requestLimits);
      }

      if (operation === "/apply") {
        return applyValidatedBody(rawBody, apply, requestLimits, validator);
      }

      return analyzeValidatedBody(rawBody, analyze, requestLimits, validator);
    }
  };
}

export const handler = createAnalyzeLambdaHandler({ cloudFormationValidator: configuredCloudFormationValidator() });

function getHttpMethod(event: ApiGatewayAnalyzeRequest): string | undefined {
  return event.httpMethod ?? event.requestContext?.http?.method;
}

function getPath(event: ApiGatewayAnalyzeRequest): string | undefined {
  return event.rawPath ?? event.path ?? event.requestContext?.http?.path;
}

function isAnalyzePath(event: ApiGatewayAnalyzeRequest): boolean {
  const path = getPath(event);

  return path === undefined || path.endsWith("/analyze");
}

function isDiffPath(event: ApiGatewayAnalyzeRequest): boolean {
  return getPath(event)?.endsWith("/diff") === true;
}

function isApplyPath(event: ApiGatewayAnalyzeRequest): boolean {
  return getPath(event)?.endsWith("/apply") === true;
}

function getOperation(event: ApiGatewayAnalyzeRequest): ApiOperation | undefined {
  if (isDiffPath(event)) {
    return "/diff";
  }

  if (isApplyPath(event)) {
    return "/apply";
  }

  return isAnalyzePath(event) ? "/analyze" : undefined;
}

function getRequestOrigin(event: ApiGatewayAnalyzeRequest): string | undefined {
  const originHeader = Object.entries(event.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "origin"
  );

  return originHeader?.[1];
}

function decodeRequestBody(event: ApiGatewayAnalyzeRequest): string | undefined {
  if (event.body === null || event.body === undefined) {
    return undefined;
  }

  if (event.isBase64Encoded === true) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }

  return event.body;
}

function jsonResponse(
  statusCode: number,
  headers: Record<string, string>,
  payload: unknown
): ApiGatewayAnalyzeResponse {
  return {
    statusCode,
    headers,
    body: JSON.stringify(payload)
  };
}

export type { ApiErrorResponse };
