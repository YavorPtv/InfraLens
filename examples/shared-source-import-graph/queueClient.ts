// @ts-nocheck
// This file is uploaded as analyzer input; its AWS SDK packages are intentionally not installed.
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const sqsClient = new SQSClient({});

export async function publishWork(queueUrl: string, orderId: string): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: orderId
    })
  );
}
