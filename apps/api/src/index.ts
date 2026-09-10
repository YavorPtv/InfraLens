import { configuredCloudFormationValidator, type CloudFormationTemplateValidator } from "./cloudFormationValidation";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response
} from "express";
import { analyzeTemplate, analyzeTemplateDiff, applyTemplateFixes } from "@infralens/analyzer";
import {
  analyzeCloudFormationBody,
  analyzeValidatedBody,
  applyValidatedBody,
  applyCloudFormationBody,
  ApiRequestError,
  diffCloudFormationBody,
  getErrorMessage,
  toApiErrorResponse,
  toApiRequestError,
  type ApiErrorCode,
  type AnalyzeTemplateDiffHandler,
  type AnalyzeTemplateHandler,
  type ApplyTemplateFixesHandler,
  type ApiErrorResponse
} from "./analyzeRequest";
import { getAllowedOrigins } from "./corsConfig";
import {
  executeLoggedOperation,
  type ApiLogWriter,
  type ApiOperation
} from "./operationLogging";
import { getApiRequestLimits, type ApiRequestLimits } from "./requestLimits";

export const apiAppName = "InfraLens API";

export type {
  AnalyzeTemplateDiffHandler,
  AnalyzeTemplateHandler,
  ApiErrorCode,
  ApiErrorResponse,
  ApplyTemplateFixesHandler
};
export { analyzeCloudFormationBody, applyCloudFormationBody, diffCloudFormationBody };
export { defaultApiRequestLimits, getApiRequestLimits } from "./requestLimits";
export type { ApiRequestLimits } from "./requestLimits";

export interface CreateApiAppOptions {
  cloudFormationValidator?: CloudFormationTemplateValidator;
  analyze?: AnalyzeTemplateHandler;
  diff?: AnalyzeTemplateDiffHandler;
  apply?: ApplyTemplateFixesHandler;
  allowedOrigins?: string[];
  requestLimits?: ApiRequestLimits;
  writeLog?: ApiLogWriter;
}

export function createApiApp(options: CreateApiAppOptions = {}): Express {
  const validator = options.cloudFormationValidator;
  const analyze = options.analyze ?? analyzeTemplate;
  const diff = options.diff ?? analyzeTemplateDiff;
  const apply = options.apply ?? applyTemplateFixes;
  const allowedOrigins = options.allowedOrigins ?? getAllowedOrigins();
  const requestLimits = options.requestLimits ?? getApiRequestLimits();
  const app = express();

  app.use(
    cors({
      allowedHeaders: ["Authorization", "Content-Type"],
      methods: ["GET", "OPTIONS", "POST"],
      origin(origin, callback) {
        if (origin === undefined || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Origin ${origin} is not allowed by CORS.`));
      }
    })
  );

  app.use(express.text({ limit: requestLimits.maxRequestBytes, type: "*/*" }));

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok"
    });
  });

  app.post("/analyze", (request, response) => {
    runApiOperation(request, response, "/analyze", options.writeLog, () =>
      analyzeValidatedBody(getRawTemplateBody(request), analyze, requestLimits, validator)
    );
  });

  app.post("/diff", (request, response) => {
    runApiOperation(request, response, "/diff", options.writeLog, () =>
      diffCloudFormationBody(getRawTemplateBody(request), diff, requestLimits)
    );
  });

  app.post("/apply", (request, response) => {
    runApiOperation(request, response, "/apply", options.writeLog, () =>
      applyValidatedBody(getRawTemplateBody(request), apply, requestLimits, validator)
    );
  });

  app.use((_request, response) => {
    writeApiError(
      response,
      new ApiRequestError(
        404,
        "NOT_FOUND",
        "Use GET /health, POST /analyze, POST /diff, or POST /apply."
      )
    );
  });

  app.use(bodyParserErrorHandler);

  return app;
}

function getRawTemplateBody(request: Request): string | undefined {
  return typeof request.body === "string" ? request.body : undefined;
}

export function createApiServer(options: CreateApiAppOptions = {}): Server {
  return createServer(createApiApp(options));
}

export function startApiServer(port = Number(process.env.PORT ?? 3000)): Server {
  const server = createApiServer({ cloudFormationValidator: configuredCloudFormationValidator() });

  server.listen(port, () => {
    process.stdout.write(`${apiAppName} listening on http://localhost:${port}\n`);
  });

  return server;
}

const bodyParserErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (isBodyParserError(error)) {
    const status = (error as { status: number }).status;
    writeApiError(
      response,
      new ApiRequestError(
        status === 413 ? 413 : 400,
        status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_TEMPLATE",
        status === 413
          ? "Request body exceeds the configured size limit."
          : "Request body must be valid CloudFormation JSON or YAML.",
        getErrorMessage(error)
      )
    );
    return;
  }

  next(error);
};

function writeApiError(response: Response, error: ApiRequestError): void {
  response.status(error.statusCode).json(toApiErrorResponse(error));
}

function isBodyParserError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const status = (error as { status?: unknown }).status;

  return typeof status === "number" && status >= 400;
}

async function runApiOperation(
  request: Request,
  response: Response,
  operation: ApiOperation,
  writeLog: ApiLogWriter | undefined,
  execute: () => ApiOperationResult | Promise<ApiOperationResult>
): Promise<void> {
  const requestId = request.header("x-request-id") ?? randomUUID();
  response.setHeader("x-request-id", requestId);

  try {
    response.json(
      await executeLoggedOperation({
        operation,
        requestId,
        rawBody: getRawTemplateBody(request),
        execute,
        ...(writeLog === undefined ? {} : { writeLog })
      })
    );
  } catch (error) {
    writeApiError(response, toApiRequestError(error));
  }
}

type ApiOperationResult = ReturnType<
  typeof analyzeCloudFormationBody | typeof diffCloudFormationBody | typeof applyCloudFormationBody
>;

if (require.main === module) {
  startApiServer();
}
