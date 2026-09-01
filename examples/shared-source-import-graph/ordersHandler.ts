import { placeOrder } from "./orderService";

interface OrderEvent {
  orderId: string;
  tableName: string;
}

export async function handler(event: OrderEvent): Promise<{ orderId: string }> {
  return placeOrder(event.tableName, event.orderId);
}
