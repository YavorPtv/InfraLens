import {
  analyzeCloudFormationBody,
  toApiErrorResponse,
  toApiRequestError,
  type AnalyzeTemplateHandler,
  type ApiErrorResponse
} from "./analyzeRequest";

export interface ApiGatewayAnalyzeRequest {
  body?: string | null;
  httpMethod?: string;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: {
      method?: string;
    };
  };
}

export interface ApiGatewayAnalyzeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface CreateAnalyzeLambdaHandlerOptions {
  analyze?: AnalyzeTemplateHandler;
}

export type AnalyzeLambdaHandler = (
  event: ApiGatewayAnalyzeRequest
) => Promise<ApiGatewayAnalyzeResponse>;

const jsonHeaders = {
  "access-control-allow-origin": "*",
  "content-type": "application/json"
};

export function createAnalyzeLambdaHandler(
  options: CreateAnalyzeLambdaHandlerOptions = {}
): AnalyzeLambdaHandler {
  const analyze = options.analyze;

  return async function analyzeLambdaHandler(event) {
    if (getHttpMethod(event) !== "POST") {
      return jsonResponse(405, {
        error: {
          code: "NOT_FOUND",
          message: "Use POST /analyze."
        }
      });
    }

    try {
      const rawBody = decodeRequestBody(event);
      const report = analyzeCloudFormationBody(rawBody, analyze);
      return jsonResponse(200, report);
    } catch (error) {
      const apiError = toApiRequestError(error);
      return jsonResponse(apiError.statusCode, toApiErrorResponse(apiError));
    }
  };
}

export const handler = createAnalyzeLambdaHandler();

function getHttpMethod(event: ApiGatewayAnalyzeRequest): string | undefined {
  return event.httpMethod ?? event.requestContext?.http?.method;
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

function jsonResponse(statusCode: number, payload: unknown): ApiGatewayAnalyzeResponse {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(payload)
  };
}

export type { ApiErrorResponse };
