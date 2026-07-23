import { expect } from "chai";
import type { AnalysisReport } from "@infralens/shared";
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

  it("returns a 400 error for invalid JSON", async () => {
    const response = await createAnalyzeLambdaHandler()({
      httpMethod: "POST",
      body: "{"
    });

    expect(response.statusCode).to.equal(400);

    const payload = readJson<ApiErrorResponse>(response);
    expect(payload.error).to.include({
      code: "INVALID_JSON",
      message: "Request body must be valid CloudFormation JSON."
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
