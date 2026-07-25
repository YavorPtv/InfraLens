import { expect } from "chai";
import type { AnalysisReport, DiffReport } from "@infralens/shared";
import { createAnalyzeLambdaHandler, type ApiGatewayAnalyzeResponse } from "../src/lambda";
import type { ApiErrorResponse } from "../src";

describe("analyze Lambda handler", () => {
  it("returns an AnalysisReport for a valid POST body", async () => {
    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "POST",
      body: JSON.stringify({
        Resources: {
          Topic: {
            Type: "AWS::SNS::Topic"
          }
        }
      })
    });

    expect(response.statusCode).to.equal(200);
    expect(response.headers["access-control-allow-origin"]).to.equal("*");

    const report = readJson<AnalysisReport>(response);
    expect(report).to.include({
      score: 100
    });
    expect(report.resources).to.deep.equal([
      {
        id: "Topic",
        type: "AWS::SNS::Topic",
        properties: {}
      }
    ]);
  });

  it("returns an AnalysisReport for a valid YAML POST body", async () => {
    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "POST",
      body: `
Resources:
  Topic:
    Type: AWS::SNS::Topic
`
    });

    expect(response.statusCode).to.equal(200);

    const report = readJson<AnalysisReport>(response);
    expect(report.resources).to.deep.equal([
      {
        id: "Topic",
        type: "AWS::SNS::Topic",
        properties: {}
      }
    ]);
  });

  it("accepts optional source files with the template", async () => {
    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "POST",
      body: JSON.stringify({
        template: JSON.stringify(lambdaDynamoTemplate()),
        sourceFiles: {
          "handler.ts": `
            await client.send(new GetCommand({ TableName: process.env.TABLE_NAME }));
            await client.send(new PutCommand({ TableName: process.env.TABLE_NAME }));
          `
        }
      })
    });

    expect(response.statusCode).to.equal(200);

    const report = readJson<AnalysisReport>(response);
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
        filePath: "handler.ts",
        matchedCommand: "GetCommand"
      },
      {
        action: "dynamodb:PutItem",
        filePath: "handler.ts",
        matchedCommand: "PutCommand"
      }
    ]);
  });

  it("returns a DiffReport for POST /diff", async () => {
    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "POST",
      path: "/diff",
      body: JSON.stringify({
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
      })
    });

    expect(response.statusCode).to.equal(200);

    const report = readJson<DiffReport>(response);
    expect(report.resources.added.map((resource) => resource.id)).to.deep.equal([
      "PublicPostMethod"
    ]);
    expect(report.findings.resolved.map(toFindingLabel)).to.deep.equal([
      "DYNAMODB_MISSING_PITR:OrdersTable"
    ]);
    expect(report.findings.introduced.map(toFindingLabel)).to.deep.equal([
      "API_GATEWAY_METHOD_NO_AUTH:PublicPostMethod"
    ]);
  });

  it("decodes base64 request bodies", async () => {
    const rawBody = JSON.stringify({
      Resources: {
        Queue: {
          Type: "AWS::SQS::Queue"
        }
      }
    });

    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "POST",
      isBase64Encoded: true,
      body: Buffer.from(rawBody, "utf8").toString("base64")
    });

    expect(response.statusCode).to.equal(200);
    expect(readJson<AnalysisReport>(response).resources[0]).to.include({
      id: "Queue",
      type: "AWS::SQS::Queue"
    });
  });

  it("returns a 400 error for a missing request body", async () => {
    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "POST"
    });

    expect(response.statusCode).to.equal(400);
    expect(readJson<ApiErrorResponse>(response)).to.deep.equal({
      error: {
        code: "MISSING_BODY",
        message: "Request body is required."
      }
    });
  });

  it("returns a 400 error for invalid input", async () => {
    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "POST",
      body: "{"
    });

    expect(response.statusCode).to.equal(400);

    const payload = readJson<ApiErrorResponse>(response);
    expect(payload.error).to.include({
      code: "INVALID_TEMPLATE",
      message: "Request body must be a valid CloudFormation template."
    });
    expect(payload.error.detail).to.be.a("string");
  });

  it("returns a 400 error for invalid CloudFormation templates", async () => {
    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "POST",
      body: JSON.stringify({
        Resources: {
          BadResource: {}
        }
      })
    });

    expect(response.statusCode).to.equal(400);

    const payload = readJson<ApiErrorResponse>(response);
    expect(payload.error).to.include({
      code: "INVALID_TEMPLATE",
      message: "Request body must be a valid CloudFormation template."
    });
    expect(payload.error.detail).to.contain("missing Type string");
  });

  it("returns a 500 error for unexpected analyzer failures", async () => {
    const response = await createAnalyzeLambdaHandler({
      analyze() {
        throw new Error("boom");
      }
    })({
      httpMethod: "POST",
      body: JSON.stringify({
        Resources: {}
      })
    });

    expect(response.statusCode).to.equal(500);
    expect(readJson<ApiErrorResponse>(response)).to.deep.equal({
      error: {
        code: "ANALYSIS_ERROR",
        message: "Template analysis failed unexpectedly.",
        detail: "boom"
      }
    });
  });

  it("returns a 405 error for non-POST requests", async () => {
    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "GET",
      body: "{}"
    });

    expect(response.statusCode).to.equal(405);
    expect(readJson<ApiErrorResponse>(response)).to.deep.equal({
      error: {
        code: "NOT_FOUND",
        message: "Use POST /analyze."
      }
    });
  });
});

function readJson<T>(response: ApiGatewayAnalyzeResponse): T {
  return JSON.parse(response.body) as T;
}

function toFindingLabel(finding: { ruleId: string; resourceId: string }): string {
  return `${finding.ruleId}:${finding.resourceId}`;
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
