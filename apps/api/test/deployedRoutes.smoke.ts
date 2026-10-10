import { expect } from "chai";
import { hostedTestRequest, readHostedTestConfiguration,
  type HostedTestConfiguration } from "./hostedTestHelpers";
import { TestUserAuthentication } from "./testUserAuthentication";

// Deliberately outside *.test.ts: ordinary tests never contact a deployment.
describe("existing deployed InfraLens API (HTTP smoke only)", function () {
  this.timeout(120_000);
  let configuration: HostedTestConfiguration;
  let authentication: TestUserAuthentication | undefined;
  const template = JSON.stringify({ Resources: { SmokeQueue: { Type: "AWS::SQS::Queue" } } });

  before(async function () {
    configuration = readHostedTestConfiguration();
    if (configuration.authenticatedSmoke) {
      authentication = new TestUserAuthentication(configuration);
      await authentication.assertDistinctUsers();
    } else {
      process.stdout.write("Public smoke only. Use --authenticated true for automatic Cognito sign-in.\n");
    }
  });

  function request(path: string, options: RequestInit = {}): Promise<Response> {
    return hostedTestRequest(configuration, path, options);
  }

  it("rejects an invalid bearer token", async () => {
    const response = await request("analyze", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-test-token" },
      body: JSON.stringify({ template })
    });
    expect(response.status).to.be.oneOf([401, 403]);
  });
  after(() => authentication?.clear());

  for (const [method, path] of [
    ["GET", "projects"], ["POST", "projects"], ["POST", "projects/cleanup"], ["POST", "projects/compare"],
    ["PATCH", "projects/test-project"], ["DELETE", "projects/test-project"],
    ["GET", "projects/test-project/runs"], ["POST", "projects/test-project/runs"],
    ["GET", "projects/test-project/runs/test-run"], ["DELETE", "projects/test-project/runs/test-run"],
    ["GET", "projects/test-project/runs/test-run/artifacts/report"]
  ]) {
    it(`rejects ${method} /${path} without authentication`, async () => {
      const response = await request(path, { method });
      expect(response.status).to.be.oneOf([401, 403]);
    });
  }

  it("returns the public health contract", async () => {
    const response = await request("health");
    expect(response.status).to.equal(200);
    expect(await response.json()).to.deep.include({ status: "ok" });
  });

  for (const path of ["analyze", "diff", "apply"]) {
    it(`rejects POST /${path} without authentication`, async () => {
      const body = path === "analyze" ? { template } : path === "diff"
        ? { oldTemplate: template, newTemplate: template } : { template, fixes: [] };
      const response = await request(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      expect(response.status).to.be.oneOf([401, 403]);
      // API Gateway owns this response, so do not impose the Lambda error schema on it.
      expect((await response.json()) as object).to.have.property("message").that.is.a("string");
    });
  }

  it("analyzes a tiny synthetic template using an automatically acquired access token", async function () {
    if (!authentication) { this.skip(); return; }
    const token = await authentication.accessToken("A");
    const response = await request("analyze", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template })
    });
    expect(response.status).to.equal(200);
    const report = await response.json() as { findings: Array<{ ruleId: string; resourceId: string }>; score: number };
    expect(report.score).to.be.a("number");
    expect(report.findings.some((f) => f.ruleId === "SQS_MISSING_DLQ" && f.resourceId === "SmokeQueue")).to.equal(true);
  });
});
