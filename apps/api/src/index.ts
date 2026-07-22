import { createServer, type Server } from "node:http";
import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response
} from "express";
import { analyzeTemplate } from "@infralens/analyzer";
import {
  analyzeCloudFormationBody,
  ApiRequestError,
  getErrorMessage,
  toApiErrorResponse,
  toApiRequestError,
  type ApiErrorCode,
  type AnalyzeTemplateHandler,
  type ApiErrorResponse
} from "./analyzeRequest";

export const apiAppName = "InfraLens API";

export type { AnalyzeTemplateHandler, ApiErrorCode, ApiErrorResponse };
export { analyzeCloudFormationBody };

export interface CreateApiAppOptions {
  analyze?: AnalyzeTemplateHandler;
  allowedOrigins?: string[];
}

interface RawBodyRequest extends Request {
  rawBody?: string;
}

export function createApiApp(options: CreateApiAppOptions = {}): Express {
  const analyze = options.analyze ?? analyzeTemplate;
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

  app.use(
    express.json({
      verify(request, _response, buffer): void {
        (request as RawBodyRequest).rawBody = buffer.toString("utf8");
      }
    })
  );

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok"
    });
  });

  app.post("/analyze", (request, response) => {
    try {
      response.json(analyzeCloudFormationBody((request as RawBodyRequest).rawBody, analyze));
    } catch (error) {
      writeApiError(response, toApiRequestError(error));
    }
  });

  app.use((_request, response) => {
    writeApiError(
      response,
      new ApiRequestError(404, "NOT_FOUND", "Use GET /health or POST /analyze.")
    );
  });

  app.use(jsonErrorHandler);

  return app;
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

const jsonErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (isJsonParseError(error)) {
    writeApiError(
      response,
      new ApiRequestError(
        400,
        "INVALID_JSON",
        "Request body must be valid CloudFormation JSON.",
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

function isJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    typeof (error as { status?: unknown }).status === "number" &&
    (error as { status?: number }).status === 400
  );
}

if (require.main === module) {
  startApiServer();
}
