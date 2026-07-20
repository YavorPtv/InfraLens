import { createServer, type Server } from "node:http";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response
} from "express";
import { analyzeTemplate } from "@infralens/analyzer";
import type { AnalysisReport } from "@infralens/shared";

export const apiAppName = "InfraLens API";

export type AnalyzeTemplateHandler = (rawTemplateJson: string) => AnalysisReport;

export type ApiErrorCode = "MISSING_BODY" | "INVALID_JSON" | "ANALYSIS_ERROR" | "NOT_FOUND";

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    detail?: string;
  };
}

export interface CreateApiAppOptions {
  analyze?: AnalyzeTemplateHandler;
}

interface RawBodyRequest extends Request {
  rawBody?: string;
}

class ApiRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly detail?: string
  ) {
    super(message);
  }
}

export function createApiApp(options: CreateApiAppOptions = {}): Express {
  const analyze = options.analyze ?? analyzeTemplate;
  const app = express();

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

export function analyzeCloudFormationBody(
  rawBody: string | undefined,
  analyze: AnalyzeTemplateHandler = analyzeTemplate
): AnalysisReport {
  if (rawBody === undefined || rawBody.trim().length === 0) {
    throw new ApiRequestError(400, "MISSING_BODY", "Request body is required.");
  }

  try {
    return analyze(rawBody);
  } catch (error) {
    throw new ApiRequestError(
      422,
      "ANALYSIS_ERROR",
      "CloudFormation template could not be analyzed.",
      getErrorMessage(error)
    );
  }
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

function toApiRequestError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) {
    return error;
  }

  return new ApiRequestError(500, "ANALYSIS_ERROR", "Unexpected API error.", getErrorMessage(error));
}

function writeApiError(response: Response, error: ApiRequestError): void {
  const payload: ApiErrorResponse = {
    error: {
      code: error.code,
      message: error.message
    }
  };

  if (error.detail !== undefined) {
    payload.error.detail = error.detail;
  }

  response.status(error.statusCode).json(payload);
}

function isJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    typeof (error as { status?: unknown }).status === "number" &&
    (error as { status?: number }).status === 400
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  startApiServer();
}
