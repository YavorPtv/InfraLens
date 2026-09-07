import { expect } from "chai";

// Deliberately outside *.test.ts: ordinary tests never contact a deployment.
describe("existing deployed InfraLens API (HTTP smoke only)", function () {
  this.timeout(15_000);
  let baseUrl: URL;
  const configuredUrl = process.env.INFRALENS_SMOKE_API_BASE_URL;
  const token = process.env.INFRALENS_SMOKE_ACCESS_TOKEN;
  const template = JSON.stringify({ Resources: { SmokeQueue: { Type: "AWS::SQS::Queue" } } });

  before(function () {
    if (!configuredUrl) {
      process.stdout.write("Smoke tests skipped: set INFRALENS_SMOKE_API_BASE_URL to an existing deployment.\n");
      this.skip();
      return;
    }
    baseUrl = new URL(configuredUrl.endsWith("/") ? configuredUrl : `${configuredUrl}/`);
    expect(baseUrl.protocol, "Use an HTTPS deployment URL").to.equal("https:");
    expect(baseUrl.username).to.equal("");
    expect(baseUrl.password).to.equal("");
    expect(baseUrl.search).to.equal("");
    expect(baseUrl.hash).to.equal("");
  });

  function request(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(new URL(path, baseUrl), {
      ...options, redirect: "error", signal: AbortSignal.timeout(10_000)
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

  it("analyzes a tiny synthetic template when an access token is explicitly supplied", async function () {
    if (!token) { this.skip(); return; }
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
