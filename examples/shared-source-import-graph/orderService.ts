import { saveOrder } from "./sharedDb";

export async function placeOrder(orderId: string): Promise<{ orderId: string }> {
  await saveOrder(orderId);
  return { orderId };
}
