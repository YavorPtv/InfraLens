// @ts-nocheck
// This file is uploaded as analyzer input; its AWS SDK packages are intentionally not installed.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const dynamodbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function saveOrder(tableName: string, orderId: string): Promise<void> {
  await dynamodbClient.send(
    new PutCommand({
      TableName: tableName,
      Item: { orderId }
    })
  );
}
