// @ts-nocheck -- uploaded analyzer fixture; SDK packages are not installed or executed.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
// Deliberate cycle: traversal must return to orderService only once per handler.
import "../../orders/services/orderService";

export async function putRecord(table: string, id: string) {
  return client.send(new PutCommand({ TableName: table, Item: { id } }));
}
