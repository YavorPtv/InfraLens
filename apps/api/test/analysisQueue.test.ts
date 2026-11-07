import { expect } from "chai";
import { describe, it } from "mocha";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SqsAnalysisQueue, drainAnalysisDlq } from "../src/analysisQueueAws";
import { AwsHistoryStore } from "../src/historyAws";
import { parseAnalysisMessage } from "../src/analysisQueue";

describe("analysis queue AWS command boundaries (offline)", () => {
  const message = {
    ownerId: "alice", projectId: "2a6c9391-c83e-4b63-b83c-437ef970766e",
    runId: "1793016000000-3a6c9391-c83e-4b63-b83c-437ef970766e",
    inputKey: "owners/alice/projects/project/runs/run/job-input.json", inputHash: "a".repeat(64)
  };

  it("sends only the pinned identifiers/references to the configured queue", async () => {
    const calls: { input: unknown }[] = [];
    const client = { send: async (command: { input: unknown }) => { calls.push(command); return {}; } } as unknown as SQSClient;
    await new SqsAnalysisQueue("queue-url", client).send(message);
    expect(calls).to.have.length(1);
    expect(calls[0].input).to.deep.equal({ QueueUrl: "queue-url", MessageBody: JSON.stringify(message) });
    expect(parseAnalysisMessage(JSON.stringify(message))).to.deep.equal(message);
  });

  it("acknowledges only durably handled DLQ messages and bounds one drain", async () => {
    const calls: { input: Record<string, unknown> }[] = [];
    const client = { send: async (command: { input: Record<string, unknown> }) => {
      calls.push(command);
      if (calls.length > 1) return {};
      return { Messages: [
        { Body: "completed", ReceiptHandle: "complete-receipt" },
        { Body: "storage-unavailable", ReceiptHandle: "retry-receipt" },
        { Body: "unknown-poison", ReceiptHandle: "poison-receipt" }
      ] };
    } } as unknown as SQSClient;
    await drainAnalysisDlq("dlq-url", async body => { if (body !== "completed") throw new Error("not durable"); }, client);
    expect(calls.map(call => call.input)).to.deep.equal([
      { QueueUrl: "dlq-url", MaxNumberOfMessages: 10, VisibilityTimeout: 120 },
      { QueueUrl: "dlq-url", ReceiptHandle: "complete-receipt" }
    ]);
  });

  it("queries only a bounded due-time GSI partition without a Scan or filter", async () => {
    const calls: { input: unknown }[] = [];
    const rows = [{ pk: "owner-project", sk: "run", version: 7 }];
    const client = { send: async (command: { input: unknown }) => { calls.push(command); return { Items: rows }; } } as unknown as DynamoDBDocumentClient;
    const store = new AwsHistoryStore({ projects: "projects", runs: "runs" }, client);
    expect(await store.dueJobs("JOB#2", 12345, 25)).to.deep.equal(rows);
    expect(calls[0].input).to.deep.equal({ TableName: "runs", IndexName: "JobRecovery",
      KeyConditionExpression: "recoveryShard = :shard AND recoveryAt <= :now",
      ExpressionAttributeValues: { ":shard": "JOB#2", ":now": 12345 }, Limit: 25 });
  });
});
