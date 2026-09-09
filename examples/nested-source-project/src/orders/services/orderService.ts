import { putRecord } from "../../shared/aws/dynamo";

export async function placeOrder(table: string, orderId: string) {
  await putRecord(table, orderId);
}
