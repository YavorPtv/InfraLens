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

    expect(withoutSyntaxDetails(inferences)).to.deep.equal([
      {
        action: "dynamodb:GetItem",
        filePath: "src/handler.ts",
        matchedCommand: "GetCommand",
        confidence: "low",
        actionConfidence: "high",
        sdkPackage: "@aws-sdk/lib-dynamodb",
        evidence: "No Lambda source mapping found for src/handler.ts."
      },
      {
        action: "dynamodb:PutItem",
        filePath: "src/handler.ts",
        matchedCommand: "PutCommand",
        confidence: "low",
        actionConfidence: "high",
        sdkPackage: "@aws-sdk/lib-dynamodb",
        evidence: "No Lambda source mapping found for src/handler.ts."
      },
      {
        action: "sqs:SendMessage",
        filePath: "src/handler.ts",
        matchedCommand: "SendMessageCommand",
        confidence: "low",
        actionConfidence: "high",
        sdkPackage: "@aws-sdk/client-sqs",
        evidence: "No Lambda source mapping found for src/handler.ts."
      }
    ]);
  });

  it("returns evidence for matches across multiple source files", () => {
    const inferences = inferIamActionsFromSourceCode({
      "src/orders.ts": `import { QueryCommand } from "@aws-sdk/lib-dynamodb";

        await client.send(new QueryCommand({ TableName: "Orders" }));
      `,
      "src/uploads.ts": `import { PutObjectCommand } from "@aws-sdk/client-s3";

        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      `
    });

    expect(withoutSyntaxDetails(inferences)).to.deep.equal([
      {
        action: "dynamodb:Query",
        filePath: "src/orders.ts",
        matchedCommand: "QueryCommand",
        confidence: "low",
        actionConfidence: "high", sdkPackage: "@aws-sdk/lib-dynamodb",
        evidence: "No Lambda source mapping found for src/orders.ts."
      },
      {
        action: "s3:PutObject",
        filePath: "src/uploads.ts",
        matchedCommand: "PutObjectCommand",
        confidence: "low",
        actionConfidence: "high", sdkPackage: "@aws-sdk/client-s3",
        evidence: "No Lambda source mapping found for src/uploads.ts."
      }
    ]);
  });

  it("maps source files to Lambda functions from handler paths", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/orders.ts": `import { GetCommand } from "@aws-sdk/lib-dynamodb";

          await client.send(new GetCommand({ TableName: "Orders" }));
        `
      },
      {
        template: {
          Resources: {
            OrdersFunction: {
              Type: "AWS::Lambda::Function",
              Properties: {
                Handler: "src/orders.handler"
              }
            }
          }
        }
      }
    );

    expect(withoutSyntaxDetails(inferences)).to.deep.equal([
      {
        action: "dynamodb:GetItem",
        filePath: "src/orders.ts",
        lambdaFunctionId: "OrdersFunction",
        matchedCommand: "GetCommand",
        confidence: "medium",
        actionConfidence: "high", sdkPackage: "@aws-sdk/lib-dynamodb",
        evidence: "Resources.OrdersFunction.Properties.Handler"
      }
    ]);
  });

  it("uses explicit source file mappings before automatic mappings", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/shared.ts": `import { SendMessageCommand } from "@aws-sdk/client-sqs";

          await client.send(new SendMessageCommand({ QueueUrl: queueUrl }));
        `
      },
      {
        template: {
          Resources: {
            OrdersFunction: {
              Type: "AWS::Lambda::Function",
              Properties: {
                Handler: "src/orders.handler"
              }
            },
            QueueFunction: {
              Type: "AWS::Lambda::Function",
              Properties: {
                Handler: "src/queue.handler"
              }
            }
          }
        },
        sourceFileMappings: {
          "src/shared.ts": "QueueFunction"
        }
      }
    );

    expect(withoutSyntaxDetails(inferences)).to.deep.equal([
      {
        action: "sqs:SendMessage",
        filePath: "src/shared.ts",
        lambdaFunctionId: "QueueFunction",
        matchedCommand: "SendMessageCommand",
        confidence: "high",
        actionConfidence: "high", sdkPackage: "@aws-sdk/client-sqs",
        evidence: "sourceFileMappings.src/shared.ts"
      }
    ]);
  });

  it("excludes source files marked as shared from Lambda-specific inference", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/shared.ts": `import { SendMessageCommand } from "@aws-sdk/client-sqs";

          await client.send(new SendMessageCommand({ QueueUrl: queueUrl }));
        `
      },
      {
        template: {
          Resources: {
            QueueFunction: {
              Type: "AWS::Lambda::Function",
              Properties: {
                Handler: "src/shared.handler"
              }
            }
          }
        },
        sourceFileExclusions: ["src/shared.ts"]
      }
    );

    expect(withoutSyntaxDetails(inferences)).to.deep.equal([]);
  });

  it("associates actions from an imported shared file with its Lambda", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/ordersHandler.ts": `import { saveOrder } from "./utils";`,
        "src/utils.ts": `import { PutCommand } from "@aws-sdk/lib-dynamodb";

          export async function saveOrder() {
            await client.send(new PutCommand({ TableName: "Orders" }));
          }
        `
      },
      {
        template: lambdaTemplate({
          OrdersFunction: "src/ordersHandler.handler"
        }),
        sourceFileMappings: {
          "src/ordersHandler.ts": "OrdersFunction"
        }
      }
    );

    expect(withoutSyntaxDetails(inferences)).to.deep.include({
      action: "dynamodb:PutItem",
      filePath: "src/utils.ts",
      lambdaFunctionId: "OrdersFunction",
      rootFilePath: "src/ordersHandler.ts",
      importChain: ["src/ordersHandler.ts", "src/utils.ts"],
      matchedCommand: "PutCommand",
      confidence: "high",
      actionConfidence: "high", sdkPackage: "@aws-sdk/lib-dynamodb",
        evidence: "sourceFileMappings.src/ordersHandler.ts"
    });
  });

  it("associates one shared file with every Lambda that imports it", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/ordersHandler.ts": `import "./shared";`,
        "src/auditHandler.ts": `const shared = require("./shared");`,
        "src/shared.ts": `import { PutCommand } from "@aws-sdk/lib-dynamodb";
await client.send(new PutCommand({ TableName: "Orders" }));`
      },
      {
        template: lambdaTemplate({
          OrdersFunction: "src/ordersHandler.handler",
          AuditFunction: "src/auditHandler.handler"
        })
      }
    );

    const sharedLambdaIds = inferences
      .filter((inference) => inference.filePath === "src/shared.ts")
      .map((inference) => inference.lambdaFunctionId)
      .sort();

    expect(sharedLambdaIds).to.deep.equal(["AuditFunction", "OrdersFunction"]);
  });

  it("does not associate an unimported shared file with a Lambda", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/ordersHandler.ts": `export function handler() { return "ok"; }`,
        "src/unrelated.ts": `import { PutCommand } from "@aws-sdk/lib-dynamodb";
await client.send(new PutCommand({ TableName: "Other" }));`
      },
      {
        template: lambdaTemplate({
          OrdersFunction: "src/ordersHandler.handler"
        })
      }
    );

    const [unrelatedInference] = inferences.filter(
      (inference) => inference.filePath === "src/unrelated.ts"
    );

    expect(unrelatedInference.lambdaFunctionId).to.equal(undefined);
  });

  it("follows transitive local imports", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/handler.ts": `import { run } from "./service";`,
        "src/service.ts": `import { load } from "./db";`,
        "src/db.ts": `import { PutCommand } from "@aws-sdk/lib-dynamodb";
await client.send(new PutCommand({ TableName: "Orders" }));`
      },
      {
        template: lambdaTemplate({
          OrdersFunction: "src/handler.handler"
        })
      }
    );

    expect(withoutSyntaxDetails(inferences)).to.deep.include({
      action: "dynamodb:PutItem",
      filePath: "src/db.ts",
      lambdaFunctionId: "OrdersFunction",
      rootFilePath: "src/handler.ts",
      importChain: ["src/handler.ts", "src/service.ts", "src/db.ts"],
      matchedCommand: "PutCommand",
      confidence: "medium",
      actionConfidence: "high", sdkPackage: "@aws-sdk/lib-dynamodb",
        evidence: "Resources.OrdersFunction.Properties.Handler"
    });
  });

  it("handles circular imports without duplicate inferences", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/handler.ts": `import { GetCommand } from "@aws-sdk/lib-dynamodb";

          import "./service";
          await client.send(new GetCommand({ TableName: "Orders" }));
        `,
        "src/service.ts": `import { PutCommand } from "@aws-sdk/lib-dynamodb";

          import "./handler";
          await client.send(new PutCommand({ TableName: "Orders" }));
        `
      },
      {
        template: lambdaTemplate({
          OrdersFunction: "src/handler.handler"
        })
      }
    );

    expect(
      inferences.filter((inference) => inference.lambdaFunctionId === "OrdersFunction")
    ).to.have.lengthOf(2);
  });

  it("keeps actions from unrelated Lambda import trees separate", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/ordersHandler.ts": `import "./ordersDb";`,
        "src/ordersDb.ts": `import { GetCommand } from "@aws-sdk/lib-dynamodb";
await client.send(new GetCommand({ TableName: "Orders" }));`,
        "src/queueHandler.ts": `import "./queueClient";`,
        "src/queueClient.ts": `import { SendMessageCommand } from "@aws-sdk/client-sqs";
await client.send(new SendMessageCommand({ QueueUrl: queueUrl }));`
      },
      {
        template: lambdaTemplate({
          OrdersFunction: "src/ordersHandler.handler",
          QueueFunction: "src/queueHandler.handler"
        })
      }
    );

    expect(
      inferences
        .filter((inference) => inference.lambdaFunctionId !== undefined)
        .map((inference) => `${inference.lambdaFunctionId}:${inference.action}`)
        .sort()
    ).to.deep.equal([
      "OrdersFunction:dynamodb:GetItem",
      "QueueFunction:sqs:SendMessage"
    ]);
  });

  it("resolves side-effect, CommonJS, explicit-extension, and index imports", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/handler.ts": `
          import "./startup.js";
          const feature = require("./feature");
        `,
        "src/startup.js": `import { PublishCommand } from "@aws-sdk/client-sns";
await client.send(new PublishCommand({ TopicArn: topicArn }));`,
        "src/feature/index.ts": `import { GetCommand } from "@aws-sdk/lib-dynamodb";
await client.send(new GetCommand({ TableName: "Orders" }));`
      },
      {
        template: lambdaTemplate({
          AppFunction: "src/handler.handler"
        })
      }
    );

    expect(
      inferences.map((inference) => `${inference.filePath}:${inference.action}`).sort()
    ).to.deep.equal([
      "src/feature/index.ts:dynamodb:GetItem",
      "src/startup.js:sns:Publish"
    ]);
  });

  it("does not guess when an extensionless import has multiple uploaded matches", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/handler.ts": `import "./utils";`,
        "src/utils.ts": `import { GetCommand } from "@aws-sdk/lib-dynamodb";
await client.send(new GetCommand({ TableName: "Orders" }));`,
        "src/utils.js": `import { PutCommand } from "@aws-sdk/lib-dynamodb";
await client.send(new PutCommand({ TableName: "Orders" }));`
      },
      {
        template: lambdaTemplate({
          AppFunction: "src/handler.handler"
        })
      }
    );

    expect(
      inferences
        .filter((inference) => inference.filePath.startsWith("src/utils."))
        .every((inference) => inference.lambdaFunctionId === undefined)
    ).to.equal(true);
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
      "src/all-commands.ts": `import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { PublishCommand } from "@aws-sdk/client-sns";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
` + commandNames
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

    expect(withoutSyntaxDetails(inferences)).to.deep.equal([]);
  });

  it("maps expanded AWS SDK commands through package-aware metadata", () => {
    const inferences = inferIamActionsFromSourceCode({
      "src/services.ts": `
        import { ListObjectsV2Command } from "@aws-sdk/client-s3";
        import { ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
        import { InvokeCommand } from "@aws-sdk/client-lambda";
        import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
        import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
        import { GetParameterCommand, GetParametersCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
        import { EncryptCommand, DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
        new ListObjectsV2Command({});
        new ReceiveMessageCommand({});
        new DeleteMessageCommand({});
        new InvokeCommand({});
        new PutEventsCommand({});
        new GetSecretValueCommand({});
        new GetParameterCommand({});
        new GetParametersCommand({});
        new PutParameterCommand({});
        new EncryptCommand({});
        new DecryptCommand({});
        new GenerateDataKeyCommand({});
      `
    });

    expect(inferences.map((inference) => inference.action)).to.deep.equal([
      "s3:ListBucket",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "lambda:InvokeFunction",
      "events:PutEvents",
      "secretsmanager:GetSecretValue",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:PutParameter",
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey"
    ]);
    expect(inferences.every((inference) => inference.actionConfidence === "low")).to.equal(true);
    expect(inferences[0].limitations?.join(" ")).to.include("version/alias");
  });

  it("does not treat an unexpected AWS SDK package as exact command evidence", () => {
    const inferences = inferIamActionsFromSourceCode({
      "src/custom.ts": `
        import { InvokeCommand } from "@aws-sdk/client-something-else";
        new InvokeCommand({});
      `
    });

    expect(inferences).to.deep.equal([]);
  });

  it("preserves separate command use locations", () => {
    const inferences = inferIamActionsFromSourceCode({ "src/repeated.ts": `import { GetObjectCommand } from "@aws-sdk/client-s3";
new GetObjectCommand({ Bucket: bucket, Key: firstKey });
new GetObjectCommand({ Bucket: bucket, Key: secondKey });` });
    expect(inferences).to.have.lengthOf(2);
    expect(inferences.map(value => value.action)).to.deep.equal(["s3:GetObject", "s3:GetObject"]);
    expect(inferences.map(value => value.useLocation)).to.deep.equal([{ line: 2, column: 1 }, { line: 3, column: 1 }]);
  });

  it("returns an empty list when no supported commands are found", () => {
    expect(
      inferIamActionsFromSourceCode({
        "src/handler.ts": "console.log('hello');"
      })
    ).to.deep.equal([]);
  });
});

function lambdaTemplate(handlers: Record<string, string>) {
  return {
    Resources: Object.fromEntries(
      Object.entries(handlers).map(([lambdaFunctionId, handler]) => [
        lambdaFunctionId,
        {
          Type: "AWS::Lambda::Function",
          Properties: {
            Handler: handler
          }
        }
      ])
    )
  };
}

function withoutSyntaxDetails<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value, (key, item) => ["importedSymbol", "localSymbol", "useLocation", "indexAccess"].includes(key) ? undefined : item));
}
