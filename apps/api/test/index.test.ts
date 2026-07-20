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

  it("returns a useful error for invalid JSON", async () => {
    const response = await postAnalyze("{");

    expect(response.status).to.equal(400);

    const payload = await readJson<ApiErrorResponse>(response);
    expect(payload.error).to.include({
      code: "INVALID_JSON",
      message: "Request body must be valid CloudFormation JSON."
    });
    expect(payload.error.detail).to.be.a("string");
  });

  it("returns a useful error for analyzer failures", async () => {
    const response = await postAnalyze(
      JSON.stringify({
        Resources: {
          BadResource: {}
        }
      })
    );

    expect(response.status).to.equal(422);

    const payload = await readJson<ApiErrorResponse>(response);
    expect(payload.error).to.include({
      code: "ANALYSIS_ERROR",
      message: "CloudFormation template could not be analyzed."
    });
    expect(payload.error.detail).to.contain("missing Type string");
  });

  function postAnalyze(body?: string): Promise<Response> {
    return fetch(`${baseUrl}/analyze`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
