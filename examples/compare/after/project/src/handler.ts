// @ts-nocheck
import { PutCommand } from "@aws-sdk/lib-dynamodb";
await client.send(new PutCommand({ TableName: process.env.TABLE_NAME }));
