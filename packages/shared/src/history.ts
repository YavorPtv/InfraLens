import type { AnalysisReport, AnalysisSummary, AnalyzeApiRequest } from "./index";

export const REPORT_SCHEMA_VERSION = "2";

export interface AnalysisVersions {
  analyzerVersion: string;
  schemaVersion: string;
}

/** Absence is legacy/unknown, never evidence that the current analyzer was used. */
export function analysisVersions(value: Partial<AnalysisVersions>): AnalysisVersions {
  return {
    analyzerVersion: value.analyzerVersion ?? "unknown",
    schemaVersion: value.schemaVersion ?? "unknown"
  };
}

export interface RunProvenance {
  kind: "apply" | "reanalysis";
  parentRun: SavedRunReference;
  inputMode: "retained" | "reuploaded" | "template-only";
  appliedFixIds?: string[];
}

export interface DeriveRunRequest {
  idempotencyKey: string;
  retainSource?: boolean;
  /** Reupload expired inputs or source that was not retained. */
  input?: AnalyzeApiRequest;
  /** Explicit consent to omit unavailable source context. */
  templateOnly?: boolean;
}

export interface ApplySavedRunRequest extends DeriveRunRequest {
  fixIds: string[];
}

export interface SavedProject {
  projectId: string;
  name: string;
  createdAt: string;
}

export interface SavedRun {
  analyzerVersion?: string;
  schemaVersion?: string;
  summary?: AnalysisSummary;
  resourceCount?: number;
  score?: number;
  sourceStatus?: "missing" | "provided" | "unknown";
  provenance?: RunProvenance;
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
  /** Only opted-in, unexpired raw inputs; never reconstructed from report evidence. */
  input?: AnalyzeApiRequest;
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
