import { saveOrder } from "./sharedDb";

export async function handler(): Promise<void> {
  await saveOrder("audit-entry-456");
}
