import { QueryCommand } from "@aws-sdk/lib-dynamodb";
export const handler = () => client.send(new QueryCommand({
  TableName: process.env.TABLE, IndexName: "ByCustomer",
  KeyConditionExpression: "customerId = :id", ExpressionAttributeValues: { ":id": "example" }
}));
