// @ts-nocheck
// This file is uploaded as analyzer input; its AWS SDK packages are intentionally not installed.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const dynamodbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function deleteUnrelatedRecord(
  tableName: string,
  recordId: string
): Promise<void> {
  await dynamodbClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { id: recordId }
    })
  );
}
