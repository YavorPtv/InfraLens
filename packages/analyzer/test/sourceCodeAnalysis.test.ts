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
        matchedCommand: "GetCommand",
        confidence: "low",
        evidence: "No Lambda source mapping found for src/handler.ts."
      },
      {
        action: "dynamodb:PutItem",
        filePath: "src/handler.ts",
        matchedCommand: "PutCommand",
        confidence: "low",
        evidence: "No Lambda source mapping found for src/handler.ts."
      },
      {
        action: "sqs:SendMessage",
        filePath: "src/handler.ts",
        matchedCommand: "SendMessageCommand",
        confidence: "low",
        evidence: "No Lambda source mapping found for src/handler.ts."
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
        matchedCommand: "QueryCommand",
        confidence: "low",
        evidence: "No Lambda source mapping found for src/orders.ts."
      },
      {
        action: "s3:PutObject",
        filePath: "src/uploads.ts",
        matchedCommand: "PutObjectCommand",
        confidence: "low",
        evidence: "No Lambda source mapping found for src/uploads.ts."
      }
    ]);
  });

  it("maps source files to Lambda functions from handler paths", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/orders.ts": `
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

    expect(inferences).to.deep.equal([
      {
        action: "dynamodb:GetItem",
        filePath: "src/orders.ts",
        lambdaFunctionId: "OrdersFunction",
        matchedCommand: "GetCommand",
        confidence: "medium",
        evidence: "Resources.OrdersFunction.Properties.Handler"
      }
    ]);
  });

  it("uses explicit source file mappings before automatic mappings", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/shared.ts": `
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

    expect(inferences).to.deep.equal([
      {
        action: "sqs:SendMessage",
        filePath: "src/shared.ts",
        lambdaFunctionId: "QueueFunction",
        matchedCommand: "SendMessageCommand",
        confidence: "high",
        evidence: "sourceFileMappings.src/shared.ts"
      }
    ]);
  });

  it("excludes source files marked as shared from Lambda-specific inference", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/shared.ts": `
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

    expect(inferences).to.deep.equal([]);
  });

  it("associates actions from an imported shared file with its Lambda", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/ordersHandler.ts": `import { saveOrder } from "./utils";`,
        "src/utils.ts": `
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

    expect(inferences).to.deep.include({
      action: "dynamodb:PutItem",
      filePath: "src/utils.ts",
      lambdaFunctionId: "OrdersFunction",
      rootFilePath: "src/ordersHandler.ts",
      importChain: ["src/ordersHandler.ts", "src/utils.ts"],
      matchedCommand: "PutCommand",
      confidence: "high",
      evidence: "sourceFileMappings.src/ordersHandler.ts"
    });
  });

  it("associates one shared file with every Lambda that imports it", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/ordersHandler.ts": `import "./shared";`,
        "src/auditHandler.ts": `const shared = require("./shared");`,
        "src/shared.ts": `await client.send(new PutCommand({ TableName: "Orders" }));`
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
        "src/unrelated.ts": `await client.send(new PutCommand({ TableName: "Other" }));`
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
        "src/db.ts": `await client.send(new PutCommand({ TableName: "Orders" }));`
      },
      {
        template: lambdaTemplate({
          OrdersFunction: "src/handler.handler"
        })
      }
    );

    expect(inferences).to.deep.include({
      action: "dynamodb:PutItem",
      filePath: "src/db.ts",
      lambdaFunctionId: "OrdersFunction",
      rootFilePath: "src/handler.ts",
      importChain: ["src/handler.ts", "src/service.ts", "src/db.ts"],
      matchedCommand: "PutCommand",
      confidence: "medium",
      evidence: "Resources.OrdersFunction.Properties.Handler"
    });
  });

  it("handles circular imports without duplicate inferences", () => {
    const inferences = inferIamActionsFromSourceCode(
      {
        "src/handler.ts": `
          import "./service";
          await client.send(new GetCommand({ TableName: "Orders" }));
        `,
        "src/service.ts": `
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
        "src/ordersDb.ts": `await client.send(new GetCommand({ TableName: "Orders" }));`,
        "src/queueHandler.ts": `import "./queueClient";`,
        "src/queueClient.ts": `await client.send(new SendMessageCommand({ QueueUrl: queueUrl }));`
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
        "src/startup.js": `await client.send(new PublishCommand({ TopicArn: topicArn }));`,
        "src/feature/index.ts": `await client.send(new GetCommand({ TableName: "Orders" }));`
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
        "src/utils.ts": `await client.send(new GetCommand({ TableName: "Orders" }));`,
        "src/utils.js": `await client.send(new PutCommand({ TableName: "Orders" }));`
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
        matchedCommand: "GetObjectCommand",
        confidence: "low",
        evidence: "No Lambda source mapping found for src/repeated.ts."
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
