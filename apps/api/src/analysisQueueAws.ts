import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import type { AnalysisMessage, AnalysisQueue } from "./analysisQueue";

export class SqsAnalysisQueue implements AnalysisQueue {
  constructor(private url: string, private client = new SQSClient({})) {}

  async send(message: AnalysisMessage): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.url, MessageBody: JSON.stringify(message) }));
  }
}

/** Acknowledge DLQ messages only after durable reconciliation. Never log message bodies. */
export async function drainAnalysisDlq(url: string, consume: (body: string) => Promise<void>, client = new SQSClient({})): Promise<void> {
  const result = await client.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, VisibilityTimeout: 120 }));
  for (const message of result.Messages ?? []) {
    if (!message.Body || !message.ReceiptHandle) continue;
    try {
      await consume(message.Body);
      await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
    } catch { /* Keep unrecognized/temporarily unavailable jobs in the DLQ for investigation. */ }
  }
}
