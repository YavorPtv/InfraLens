import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";
import type { AnalysisReport, ApplySuggestionsResult, DiffReport } from "@infralens/shared";
import type { ApiErrorResponse } from "../src";
import { createApiApp } from "../src";

describe("local API", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach((done) => {
    server = createApiApp().listen(0, () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it("returns health status", async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).to.equal(200);
    expect(await readJson<{ status: string }>(response)).to.deep.equal({
      status: "ok"
    });
  });

  it("allows the local web app origin with CORS", async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: {
        Origin: "http://localhost:5173"
      }
    });

    expect(response.status).to.equal(200);
    expect(response.headers.get("access-control-allow-origin")).to.equal(
      "http://localhost:5173"
    );
  });

  it("returns an AnalysisReport from POST /analyze", async () => {
    const response = await postAnalyze(
      JSON.stringify({
        Resources: {
          Topic: {
            Type: "AWS::SNS::Topic",
            Properties: { KmsMasterKeyId: "alias/aws/sns" }
          }
        }
      })
    );

    expect(response.status).to.equal(200);

    const report = await readJson<AnalysisReport>(response);
    expect(report).to.include({
      score: 100
    });
    expect(report).to.have.keys([
      "analysisStatus",
      "validation",
      "score",
      "summary",
      "findings",
      "resources",
      "edges",
      "publicEntryPointIds",
      "publiclyReachableResourceIds",
      "leastPrivilegeSuggestions",
      "templateFixes"
    ]);
    expect(report.resources).to.deep.equal([
      {
        id: "Topic",
        type: "AWS::SNS::Topic",
        properties: { KmsMasterKeyId: "alias/aws/sns" }
      }
    ]);
  });

  it("returns an AnalysisReport for YAML input from POST /analyze", async () => {
    const response = await postAnalyze(`
Resources:
  Queue:
    Type: AWS::SQS::Queue
`);

    expect(response.status).to.equal(200);

    const report = await readJson<AnalysisReport>(response);
    expect(report.resources).to.deep.equal([
      {
        id: "Queue",
        type: "AWS::SQS::Queue",
        properties: {}
      }
    ]);
  });

  it("applies selected structured fixes through POST /apply", async () => {
    const template = JSON.stringify({
      Resources: {
        OrdersTable: {
          Type: "AWS::DynamoDB::Table"
        }
      }
    });
    const analysisResponse = await postAnalyze(template);
    const report = await readJson<AnalysisReport>(analysisResponse);
    const fix = report.templateFixes?.find((candidate) => candidate.applicability === "applicable");

    const response = await fetch(`${baseUrl}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template, fixes: fix === undefined ? [] : [fix] })
    });

    expect(response.status).to.equal(200);
    const result = await readJson<ApplySuggestionsResult>(response);
    expect(result.appliedFixCount).to.equal(1);
    expect(result.modifiedTemplate.Resources.OrdersTable.Properties).to.deep.equal({
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true
      }
    });
  });

  it("returns a clear error for malformed fixes", async () => {
    const response = await fetch(`${baseUrl}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: JSON.stringify({ Resources: {} }),
        fixes: [{ id: "incomplete" }]
      })
    });

    expect(response.status).to.equal(400);
    expect(await readJson<ApiErrorResponse>(response)).to.deep.equal({
      error: {
        code: "INVALID_FIX",
        message: "Each fix must be a valid structured template fix."
      }
    });
  });

  it("accepts optional source files with the template", async () => {
    const response = await fetch(`${baseUrl}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        template: JSON.stringify(lambdaDynamoTemplate()),
        sourceFiles: {
          "src/order-handler.ts": `
            import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
            await client.send(new GetCommand({ TableName: process.env.TABLE_NAME }));
            await client.send(new PutCommand({ TableName: process.env.TABLE_NAME }));
          `
        },
        sourceFileMappings: {
          "src/order-handler.ts": "AppFunction"
        }
      })
    });

    expect(response.status).to.equal(200);

    const report = await readJson<AnalysisReport>(response);
    expect(report.leastPrivilegeSuggestions).to.have.lengthOf(1);
    expect(report.leastPrivilegeSuggestions[0]).to.include({
      confidence: "high"
    });
    expect(report.leastPrivilegeSuggestions[0].currentActions).to.deep.equal(["dynamodb:*"]);
    expect(report.leastPrivilegeSuggestions[0].suggestedActions).to.deep.equal([
      "dynamodb:GetItem",
      "dynamodb:PutItem"
    ]);
    expect(report.leastPrivilegeSuggestions[0].actions).to.deep.equal([
      "dynamodb:GetItem",
      "dynamodb:PutItem"
    ]);
    expect(report.leastPrivilegeSuggestions[0].evidence.sourceActions).to.deep.equal([
      {
        action: "dynamodb:GetItem",
        filePath: "src/order-handler.ts",
        lambdaFunctionId: "AppFunction",
        matchedCommand: "GetCommand",
        confidence: "high",
        actionConfidence: "high",
        sdkPackage: "@aws-sdk/lib-dynamodb",
        evidence: "sourceFileMappings.src/order-handler.ts"
      },
      {
        action: "dynamodb:PutItem",
        filePath: "src/order-handler.ts",
        lambdaFunctionId: "AppFunction",
        matchedCommand: "PutCommand",
        confidence: "high",
        actionConfidence: "high",
        sdkPackage: "@aws-sdk/lib-dynamodb",
        evidence: "sourceFileMappings.src/order-handler.ts"
      }
    ]);
  });

  it("returns a DiffReport from POST /diff", async () => {
    const response = await postDiff({
      oldTemplate: JSON.stringify({
        Resources: {
          OrdersTable: {
            Type: "AWS::DynamoDB::Table"
          }
        }
      }),
      newTemplate: JSON.stringify({
        Resources: {
          OrdersTable: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              PointInTimeRecoverySpecification: {
                PointInTimeRecoveryEnabled: true
              }
            }
          },
          PublicPostMethod: {
            Type: "AWS::ApiGateway::Method",
            Properties: {
              AuthorizationType: "NONE"
            }
          }
        }
      })
    });

    expect(response.status).to.equal(200);

    const report = await readJson<DiffReport>(response);
    expect(report.resources.added.map((resource) => resource.id)).to.deep.equal([
      "PublicPostMethod"
    ]);
    expect(report.resources.changed.map((resource) => resource.resourceId)).to.deep.equal([
      "OrdersTable"
    ]);
    expect(report.findings.resolved.map(toFindingLabel)).to.deep.equal([
      "DYNAMODB_MISSING_PITR:OrdersTable"
    ]);
    expect(report.findings.introduced.map(toFindingLabel)).to.deep.equal([
      "API_GATEWAY_METHOD_NO_AUTH:PublicPostMethod"
    ]);
  });

  it("returns expected compare workflow results from fixture templates", async () => {
    const response = await postDiff({
      oldTemplate: readExampleFixture("compare/old-order-service-template.json"),
      newTemplate: readExampleFixture("compare/new-order-service-template.json")
    });

    expect(response.status).to.equal(200);

    const report = await readJson<DiffReport>(response);
    expect(report.resources.added.map((resource) => resource.id)).to.deep.equal([
      "OrderDeadLetterQueue",
      "OrdersApi",
      "OrdersResource",
      "PublicOrdersMethod",
      "ReportRole",
      "UploadBucket"
    ]);
    expect(report.resources.removed.map((resource) => resource.id)).to.deep.equal([
      "LegacyTopic"
    ]);
    expect(report.resources.changed.map((resource) => resource.resourceId)).to.deep.equal([
      "OrdersTable",
      "OrderQueue",
      "OrderLogGroup"
    ]);
    expect(report.findings.introduced.map(toFindingLabel)).to.have.members([
      "IAM_WILDCARD_PERMISSIONS:ReportRole",
      "S3_PUBLIC_ACCESS_BLOCK_MISSING:UploadBucket",
      "S3_VERSIONING_DISABLED:UploadBucket",
      "API_GATEWAY_METHOD_NO_AUTH:PublicOrdersMethod"
    ]);
    expect(report.findings.resolved.map(toFindingLabel)).to.have.members([
      "DYNAMODB_MISSING_PITR:OrdersTable",
      "SQS_MISSING_DLQ:OrderQueue",
      "LOG_GROUP_MISSING_RETENTION:OrderLogGroup",
      "SNS_TOPIC_ENCRYPTION_MISSING:LegacyTopic"
    ]);
  });

  it("returns a useful error for a missing diff request body", async () => {
    const response = await fetch(`${baseUrl}/diff`, {
      method: "POST"
    });

    expect(response.status).to.equal(400);
    expect(await readJson<ApiErrorResponse>(response)).to.deep.equal({
      error: {
        code: "MISSING_BODY",
        message: "Request body is required."
      }
    });
  });

  it("returns a useful error for a missing request body", async () => {
    const response = await postAnalyze();

    expect(response.status).to.equal(400);

    const payload = await readJson<ApiErrorResponse>(response);
    expect(payload).to.deep.equal({
      error: {
        code: "MISSING_BODY",
        message: "Request body is required."
      }
    });
  });

  it("returns a useful error for invalid input", async () => {
    const response = await postAnalyze("{");

    expect(response.status).to.equal(400);

    const payload = await readJson<ApiErrorResponse>(response);
    expect(payload.error).to.include({
      code: "INVALID_TEMPLATE",
      message: "CloudFormation template validation failed."
    });
    expect(payload.error.detail).to.be.a("string");
  });

  it("returns a useful error for invalid CloudFormation templates", async () => {
    const response = await postAnalyze(
      JSON.stringify({
        Resources: {
          BadResource: {}
        }
      })
    );

    expect(response.status).to.equal(400);

    const payload = await readJson<ApiErrorResponse>(response);
    expect(payload.error).to.include({
      code: "INVALID_TEMPLATE",
      message: "CloudFormation template validation failed."
    });
    expect(payload.error.detail).to.contain("non-empty Type string");
  });

  function postAnalyze(body?: string): Promise<Response> {
    return fetch(`${baseUrl}/analyze`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "text/plain"
      }
    });
  }

  function postDiff(body: { oldTemplate: string; newTemplate: string }): Promise<Response> {
    return fetch(`${baseUrl}/diff`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function toFindingLabel(finding: { ruleId: string; resourceId: string }): string {
  return `${finding.ruleId}:${finding.resourceId}`;
}

function readExampleFixture(fixtureName: string): string {
  return readFileSync(resolve("../../examples", fixtureName), "utf8");
}

function lambdaDynamoTemplate(): Record<string, unknown> {
  return {
    Resources: {
      AppFunction: {
        Type: "AWS::Lambda::Function",
        Properties: {
          Role: {
            "Fn::GetAtt": ["AppRole", "Arn"]
          },
          Environment: {
            Variables: {
              TABLE_NAME: {
                Ref: "AppTable"
              }
            }
          }
        }
      },
      AppRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          Policies: [
            {
              PolicyName: "DynamoAccess",
              PolicyDocument: {
                Statement: {
                  Effect: "Allow",
                  Action: "dynamodb:*",
                  Resource: "*"
                }
              }
            }
          ]
        }
      },
      AppTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true
          }
        }
      }
    }
  };
}
