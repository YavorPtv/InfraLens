// @ts-nocheck -- uploaded analyzer fixture; SDK packages are not installed or executed.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import "./services/orderService";

export async function updateOrder(table: string, orderId: string) {
  return client.send(new UpdateCommand({ TableName: table, Key: { orderId },
    UpdateExpression: "SET orderStatus = :status", ExpressionAttributeValues: { ":status": "created" } }));
}
