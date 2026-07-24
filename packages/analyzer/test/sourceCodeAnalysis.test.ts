import { expect } from "chai";
import { inferIamActionsFromSourceCode } from "../src";

describe("inferIamActionsFromSourceCode", () => {
  it("infers IAM actions from AWS SDK v3 command usages", () => {
    const inferences = inferIamActionsFromSourceCode({
      "src/handler.ts": `
        import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
        import { SendMessageCommand } from "@aws-sdk/client-sqs";

        await dynamodb.send(new GetCommand({ TableName: "Orders" }));
        await dynamodb.send(new PutCommand({ TableName: "Orders" }));
        await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl }));
      `
    });

    expect(inferences).to.deep.equal([
      {
        action: "dynamodb:GetItem",
        filePath: "src/handler.ts",
        matchedCommand: "GetCommand"
      },
      {
        action: "dynamodb:PutItem",
        filePath: "src/handler.ts",
        matchedCommand: "PutCommand"
      },
      {
        action: "sqs:SendMessage",
        filePath: "src/handler.ts",
        matchedCommand: "SendMessageCommand"
      }
    ]);
  });

  it("returns evidence for matches across multiple source files", () => {
    const inferences = inferIamActionsFromSourceCode({
      "src/orders.ts": `
        await client.send(new QueryCommand({ TableName: "Orders" }));
      `,
      "src/uploads.ts": `
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      `
    });

    expect(inferences).to.deep.equal([
      {
        action: "dynamodb:Query",
        filePath: "src/orders.ts",
        matchedCommand: "QueryCommand"
      },
      {
        action: "s3:PutObject",
        filePath: "src/uploads.ts",
        matchedCommand: "PutObjectCommand"
      }
    ]);
  });

  it("supports the initial command-to-action mapping", () => {
    const commandNames = [
      "GetCommand",
      "PutCommand",
      "UpdateCommand",
      "DeleteCommand",
      "QueryCommand",
      "ScanCommand",
      "SendMessageCommand",
      "PublishCommand",
      "GetObjectCommand",
      "PutObjectCommand",
      "DeleteObjectCommand"
    ];

    const inferences = inferIamActionsFromSourceCode({
      "src/all-commands.ts": commandNames
        .map((commandName) => `await client.send(new ${commandName}({}));`)
        .join("\n")
    });

    expect(inferences.map((inference) => inference.action)).to.deep.equal([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "sqs:SendMessage",
      "sns:Publish",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject"
    ]);
  });

  it("does not infer actions from partial command-name matches", () => {
    const inferences = inferIamActionsFromSourceCode({
      "src/not-aws.ts": `
        const value = "MyGetCommand";
        const other = "GetCommandSuffix";
        class CustomSendMessageCommandWrapper {}
      `
    });

    expect(inferences).to.deep.equal([]);
  });

  it("returns one inference per command per file", () => {
    const inferences = inferIamActionsFromSourceCode({
      "src/repeated.ts": `
        await client.send(new GetObjectCommand({ Bucket: bucket, Key: firstKey }));
        await client.send(new GetObjectCommand({ Bucket: bucket, Key: secondKey }));
      `
    });

    expect(inferences).to.deep.equal([
      {
        action: "s3:GetObject",
        filePath: "src/repeated.ts",
        matchedCommand: "GetObjectCommand"
      }
    ]);
  });

  it("returns an empty list when no supported commands are found", () => {
    expect(
      inferIamActionsFromSourceCode({
        "src/handler.ts": "console.log('hello');"
      })
    ).to.deep.equal([]);
  });
});
