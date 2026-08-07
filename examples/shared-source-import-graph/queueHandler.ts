import { publishWork } from "./queueClient";

export async function handler(): Promise<void> {
  await publishWork("order-123");
}
