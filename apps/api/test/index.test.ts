import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "chai";
import type { AnalysisReport } from "@infralens/shared";
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
            Type: "AWS::SNS::Topic"
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
      "score",
      "summary",
      "findings",
      "resources",
      "edges",
      "publicEntryPointIds",
      "publiclyReachableResourceIds",
      "leastPrivilegeSuggestions"
    ]);
    expect(report.resources).to.deep.equal([
      {
        id: "Topic",
        type: "AWS::SNS::Topic",
        properties: {}
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

  it("accepts optional source files with the template", async () => {
    const response = await fetch(`${baseUrl}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
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
      message: "Request body must be a valid CloudFormation template."
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
      message: "Request body must be a valid CloudFormation template."
    });
    expect(payload.error.detail).to.contain("missing Type string");
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
});

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
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
