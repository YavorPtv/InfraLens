import { publishWork } from "./queueClient";

interface QueueEvent {
  orderId: string;
  queueUrl: string;
}

export async function handler(event: QueueEvent): Promise<void> {
  await publishWork(event.queueUrl, event.orderId);
}
