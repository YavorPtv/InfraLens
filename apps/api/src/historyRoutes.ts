import type {
  CompareSavedRunsRequest,
  SaveAnalysisRequest,
  SavedRunReference
} from "@infralens/shared";
import { ApiRequestError } from "./analyzeRequest";
import { HistoryService } from "./historyService";

export interface HistoryRequest {
  method: string;
  path: string;
  owner?: string;
  body?: string;
  query?: Record<string, string | undefined>;
}

export interface HistoryResponse {
  statusCode: number;
  payload: unknown;
}

const invalidRequest = (message: string): never => {
  throw new ApiRequestError(400, "INVALID_REQUEST", message);
};

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidRequest("A JSON object is required.");
  }
  return value as Record<string, unknown>;
}

function assertAllowedFields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalidRequest("Unsupported request field. Identity and artifact keys are server-controlled.");
  }
}

function parseProjectName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    return invalidRequest("Project name must be 1–120 characters.");
  }
  return value.trim();
}

function parseRunReference(value: unknown): SavedRunReference {
  const reference = requireRecord(value);
  assertAllowedFields(reference, ["projectId", "runId"]);
  if (
    typeof reference.projectId !== "string" ||
    typeof reference.runId !== "string" ||
    !isValidProjectId(reference.projectId) ||
    !isValidRunId(reference.runId)
  ) {
    return invalidRequest("Invalid run reference.");
  }
  return {
    projectId: reference.projectId,
    runId: reference.runId
  };
}

const isValidProjectId = (id: string) => /^[0-9a-f-]{36}$/.test(id);

const isValidRunId = (id: string) => /^\d{13}-[0-9a-f-]{36}$/.test(id);

export async function routeHistory(
  service: HistoryService | undefined,
  request: HistoryRequest,
  maxRequestBytes: number
): Promise<HistoryResponse> {
  // Only the transport can supply owner, from authorizer claims or an explicit local configuration.
  const owner = request.owner;
  if (!owner || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) {
    throw new ApiRequestError(401, "UNAUTHORIZED", "Authenticated Cognito sub is required.");
  }
  if (!service) {
    throw new ApiRequestError(503, "UNAVAILABLE", "Saved projects storage is not configured.");
  }
  if (Buffer.byteLength(request.body ?? "") > maxRequestBytes) {
    throw new ApiRequestError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body exceeds the configured size limit."
    );
  }
  const pathParts = request.path.split("/").filter(Boolean);
  const query = request.query ?? {};
  assertAllowedFields(query, ["limit", "cursor"]);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    invalidRequest("Page limit must be 1–50.");
  }
  let body: Record<string, unknown> = {};
  if (request.body) {
    try {
      body = requireRecord(JSON.parse(request.body));
    } catch (error) {
      if (error instanceof ApiRequestError) {
        throw error;
      }
      invalidRequest("Invalid JSON body.");
    }
  }
  const method = request.method;
  if (method === "GET" || method === "DELETE") {
    assertAllowedFields(body, []);
  }
  const jsonResponse = (payload: unknown, statusCode = 200) => ({
    statusCode,
    payload
  });
  if (pathParts.length === 1) {
    if (method === "GET") {
      return jsonResponse(await service.listProjects(owner, limit, query.cursor));
    }
    if (method === "POST") {
      assertAllowedFields(body, ["name"]);
      return jsonResponse(await service.createProject(owner, parseProjectName(body.name)), 201);
    }
  }
  if (pathParts.length === 2 && pathParts[1] === "cleanup" && method === "POST") {
    assertAllowedFields(body, []);
    return jsonResponse(await service.cleanup(owner, limit, query.cursor));
  }
  if (pathParts.length === 2 && pathParts[1] === "compare" && method === "POST") {
    assertAllowedFields(body, ["oldRun", "newRun"]);
    const comparisonRequest: CompareSavedRunsRequest = {
      oldRun: parseRunReference(body.oldRun),
      newRun: parseRunReference(body.newRun)
    };
    return jsonResponse(
      await service.compare(owner, comparisonRequest.oldRun, comparisonRequest.newRun)
    );
  }
  const projectId = pathParts[1];
  if (!projectId || !isValidProjectId(projectId)) {
    invalidRequest("Invalid project ID.");
  }
  if (pathParts.length === 2) {
    if (method === "PATCH") {
      assertAllowedFields(body, ["name"]);
      return jsonResponse(
        await service.renameProject(owner, projectId, parseProjectName(body.name))
      );
    }
    if (method === "DELETE") {
      return jsonResponse(await service.deleteProject(owner, projectId));
    }
  }
  if (pathParts[2] === "runs" && pathParts.length === 3) {
    if (method === "GET") {
      return jsonResponse(await service.listRuns(owner, projectId, limit, query.cursor));
    }
    if (method === "POST") {
      const saveRequest = parseSaveRequest(body);
      return jsonResponse(await service.save(owner, projectId, saveRequest), 201);
    }
  }
  const runId = pathParts[3];
  if (pathParts[2] === "runs" && runId && isValidRunId(runId)) {
    if (pathParts.length === 4) {
      if (method === "GET") {
        return jsonResponse(await service.open(owner, projectId, runId));
      }
      if (method === "DELETE") {
        return jsonResponse(await service.deleteRun(owner, projectId, runId));
      }
    }
    if (pathParts.length === 6 && pathParts[4] === "artifacts" && method === "GET") {
      const artifactName = pathParts[5];
      if (artifactName !== "report" && artifactName !== "markdown" && artifactName !== "input") {
        invalidRequest("Unknown artifact.");
      }
      return jsonResponse(
        await service.download(
          owner,
          projectId,
          runId,
          artifactName as "report" | "markdown" | "input"
        )
      );
    }
  }
  throw new ApiRequestError(404, "NOT_FOUND", "Saved projects route not found.");
}

function parseSaveRequest(body: Record<string, unknown>): SaveAnalysisRequest {
  assertAllowedFields(body, ["input", "idempotencyKey", "retainSource"]);
  const input = requireRecord(body.input);
  assertAllowedFields(input, [
    "template",
    "sourceFiles",
    "sourceFileMappings",
    "sourceFileExclusions"
  ]);
  if (typeof input.template !== "string" || !input.template.trim()) {
    invalidRequest("input.template must be a non-empty string.");
  }
  if (
    typeof body.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(body.idempotencyKey)
  ) {
    invalidRequest("idempotencyKey must be 8–128 letters, digits, underscores or hyphens.");
  }
  if (body.retainSource !== undefined && typeof body.retainSource !== "boolean") {
    invalidRequest("retainSource must be boolean.");
  }
  return body as unknown as SaveAnalysisRequest;
}
