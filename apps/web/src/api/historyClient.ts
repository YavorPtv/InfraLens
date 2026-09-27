import type {
  HistoryPage,
  SavedProject,
  SavedRun,
  SaveAnalysisRequest,
  OpenSavedRun,
  DiffReport,
  SavedRunReference
} from "@infralens/shared";

export class HistoryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Transport injection also lets workflow tests simulate a completely fresh client/session. */
export function createHistoryClient(baseUrl: string, fetcher: typeof fetch) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "").replace(/\/analyze$/, "");
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetcher(`${normalizedBaseUrl}/projects${path}`, {
      method,
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new HistoryRequestError(
        payload.error?.message ?? "Saved projects request failed.",
        response.status
      );
    }
    return payload as T;
  }
  const pageQuery = (cursor?: string) => (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
  const runPath = (projectId: string, runId: string) =>
    `/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;
  return {
    projects: (cursor?: string) => request<HistoryPage<SavedProject>>(pageQuery(cursor)),
    create: (name: string) => request<SavedProject>("", "POST", { name }),
    rename: (projectId: string, name: string) =>
      request<SavedProject>(`/${projectId}`, "PATCH", { name }),
    deleteProject: (projectId: string) =>
      request<{ cleanupPending: boolean }>(`/${projectId}`, "DELETE"),
    cleanup: (cursor?: string) =>
      request<{
        cleanupPending: boolean;
        nextCursor?: string;
      }>(`/cleanup${pageQuery(cursor)}`, "POST"),
    runs: (projectId: string, cursor?: string) =>
      request<HistoryPage<SavedRun>>(`/${projectId}/runs${pageQuery(cursor)}`),
    save: (projectId: string, body: SaveAnalysisRequest) =>
      request<OpenSavedRun>(`/${projectId}/runs`, "POST", body),
    open: (projectId: string, runId: string) => request<OpenSavedRun>(runPath(projectId, runId)),
    deleteRun: (projectId: string, runId: string) =>
      request<{ cleanupPending: boolean }>(runPath(projectId, runId), "DELETE"),
    compare: (oldRun: SavedRunReference, newRun: SavedRunReference) =>
      request<DiffReport>("/compare", "POST", {
        oldRun,
        newRun
      })
  };
}

export async function restoreSavedReport(
  client: ReturnType<typeof createHistoryClient>,
  projectId: string,
  runId: string,
  state: {
    setReport: (report: OpenSavedRun["report"]) => void;
    setOriginalTemplateInput: (template: string | null) => void;
  }
): Promise<OpenSavedRun> {
  const result = await client.open(projectId, runId);
  state.setReport(result.report);
  state.setOriginalTemplateInput(result.template ?? null);
  return result;
}
