import { saveOrder } from "./sharedDb";

export async function placeOrder(
  tableName: string,
  orderId: string
): Promise<{ orderId: string }> {
  await saveOrder(tableName, orderId);
  return { orderId };
}
