import type { HistoryService } from "./historyService";
import { parseAnalysisMessage } from "./analysisQueue";
import { configuredHistory } from "./historyConfig";

export interface AnalysisBatch { Records: { messageId: string; body: string }[] }

export function createAnalysisWorker(history: HistoryService) {
  return async (event: AnalysisBatch) => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try { await history.processJob(parseAnalysisMessage(record.body)); }
      catch { batchItemFailures.push({ itemIdentifier: record.messageId }); }
    }
    return { batchItemFailures };
  };
}

export async function handler(event: AnalysisBatch) {
  const history = configuredHistory(true);
  if (!history) throw new Error("History storage is required");
  return createAnalysisWorker(history)(event);
}
