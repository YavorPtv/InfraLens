import { publishPayment } from "./service";

export async function handler(event: { queueUrl: string; paymentId: string }) {
  await publishPayment(event.queueUrl, event.paymentId);
}
