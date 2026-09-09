// @ts-nocheck -- uploaded analyzer fixture; SDK packages are not installed or executed.
import { SendMessageCommand } from "@aws-sdk/client-sqs";

export async function publishPayment(queueUrl: string, paymentId: string) {
  return client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: paymentId }));
}
