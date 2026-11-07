import { configuredHistory } from "./historyConfig";
import { parseAnalysisMessage } from "./analysisQueue";
import { drainAnalysisDlq } from "./analysisQueueAws";

export async function handler(): Promise<void> {
  const history = configuredHistory(true);
  if (!history) throw new Error("History storage is required");
  const dlq = process.env.INFRALENS_ANALYSIS_DLQ_URL;
  if (dlq) await drainAnalysisDlq(dlq, body => history.processJob(parseAnalysisMessage(body), true));
  await history.reconcileJobs();
}
