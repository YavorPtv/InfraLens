/** Queue payloads contain identifiers and immutable references, never uploaded bodies. */
export interface AnalysisMessage {
  ownerId: string;
  projectId: string;
  runId: string;
  inputKey: string;
  inputHash: string;
}

export interface AnalysisQueue {
  send(message: AnalysisMessage): Promise<void>;
}

export const jobLeaseMs = 120_000; // Longer than the worker's hard 60-second lifetime.
export const jobRecoveryMs = 360_000; // SQS visibility timeout, also six times worker lifetime.
export const jobDeadlineMs = 30 * 60_000;
export const maxJobAttempts = 3;
export const recoveryShards = ["JOB#0", "JOB#1", "JOB#2", "JOB#3"];

export function parseAnalysisMessage(body: string): AnalysisMessage {
  const value = JSON.parse(body) as AnalysisMessage;
  if (!value || Object.keys(value).sort().join(",") !== "inputHash,inputKey,ownerId,projectId,runId" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.ownerId) ||
      !/^[a-f0-9-]{36}$/.test(value.projectId) ||
      !/^\d{13}-[a-f0-9-]{36}$/.test(value.runId) ||
      typeof value.inputKey !== "string" || !/^[a-f0-9]{64}$/.test(value.inputHash)) {
    throw new Error("Invalid analysis message");
  }
  return value;
}
