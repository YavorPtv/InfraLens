import type { AnalysisReport, AnalyzeApiRequest } from "./index";

export interface SavedProject {
  projectId: string;
  name: string;
  createdAt: string;
}

export interface SavedRun {
  projectId: string;
  runId: string;
  createdAt: string;
  inputExpiresAt: string;
  sourceRetained: boolean;
  retainedInputBytes: number;
}

export interface HistoryPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface SaveAnalysisRequest {
  input: AnalyzeApiRequest;
  idempotencyKey: string;
  retainSource?: boolean;
}

export interface OpenSavedRun {
  run: SavedRun;
  report: AnalysisReport;
  template?: string;
}

export type SavedArtifact = "report" | "markdown" | "input";

export interface SavedRunReference {
  projectId: string;
  runId: string;
}

export interface CompareSavedRunsRequest {
  oldRun: SavedRunReference;
  newRun: SavedRunReference;
}
