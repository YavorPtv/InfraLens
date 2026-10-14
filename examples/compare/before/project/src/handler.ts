// @ts-nocheck
import { GetCommand } from "@aws-sdk/lib-dynamodb";
await client.send(new GetCommand({ TableName: process.env.TABLE_NAME }));
