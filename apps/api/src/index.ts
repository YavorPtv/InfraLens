import { createServer, type Server } from "node:http";
import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response
} from "express";
import { analyzeTemplate, analyzeTemplateDiff } from "@infralens/analyzer";
import {
  analyzeCloudFormationBody,
  ApiRequestError,
  diffCloudFormationBody,
  getErrorMessage,
  toApiErrorResponse,
  toApiRequestError,
  type ApiErrorCode,
  type AnalyzeTemplateDiffHandler,
  type AnalyzeTemplateHandler,
  type ApiErrorResponse
} from "./analyzeRequest";

export const apiAppName = "InfraLens API";

export type { AnalyzeTemplateDiffHandler, AnalyzeTemplateHandler, ApiErrorCode, ApiErrorResponse };
export { analyzeCloudFormationBody, diffCloudFormationBody };

export interface CreateApiAppOptions {
  analyze?: AnalyzeTemplateHandler;
  diff?: AnalyzeTemplateDiffHandler;
  allowedOrigins?: string[];
}

export function createApiApp(options: CreateApiAppOptions = {}): Express {
  const analyze = options.analyze ?? analyzeTemplate;
  const diff = options.diff ?? analyzeTemplateDiff;
  const allowedOrigins = options.allowedOrigins ?? getAllowedOrigins();
  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        if (origin === undefined || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Origin ${origin} is not allowed by CORS.`));
      }
    })
  );

  app.use(express.text({ type: "*/*" }));

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok"
    });
  });

  app.post("/analyze", (request, response) => {
    try {
      response.json(analyzeCloudFormationBody(getRawTemplateBody(request), analyze));
    } catch (error) {
      writeApiError(response, toApiRequestError(error));
    }
  });

  app.post("/diff", (request, response) => {
    try {
      response.json(diffCloudFormationBody(getRawTemplateBody(request), diff));
    } catch (error) {
      writeApiError(response, toApiRequestError(error));
    }
  });

  app.use((_request, response) => {
    writeApiError(
      response,
      new ApiRequestError(404, "NOT_FOUND", "Use GET /health, POST /analyze, or POST /diff.")
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
  const server = createApiServer();

  server.listen(port, () => {
    process.stdout.write(`${apiAppName} listening on http://localhost:${port}\n`);
  });

  return server;
}

const bodyParserErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (isBodyParserError(error)) {
    writeApiError(
      response,
      new ApiRequestError(
        400,
        "INVALID_TEMPLATE",
        "Request body must be valid CloudFormation JSON or YAML.",
        getErrorMessage(error)
      )
    );
    return;
  }

  next(error);
};

function getAllowedOrigins(): string[] {
  const configuredOrigins = process.env.INFRALENS_CORS_ORIGINS;

  if (configuredOrigins !== undefined && configuredOrigins.trim().length > 0) {
    return configuredOrigins
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}

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

if (require.main === module) {
  startApiServer();
}
