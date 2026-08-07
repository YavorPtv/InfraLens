import { placeOrder } from "./orderService";

export async function handler(): Promise<{ orderId: string }> {
  return placeOrder("order-123");
}
