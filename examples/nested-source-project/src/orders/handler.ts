import { placeOrder } from "./services/orderService";
import { updateOrder } from "./service";

export async function handler(event: { table: string; orderId: string }) {
  await placeOrder(event.table, event.orderId);
  await updateOrder(event.table, event.orderId);
}
