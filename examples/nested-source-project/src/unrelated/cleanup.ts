// @ts-nocheck -- uploaded analyzer fixture; never imported by a handler.
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
export const cleanup = () => client.send(new DeleteCommand({ TableName: "Unrelated", Key: { id: "example" } }));
