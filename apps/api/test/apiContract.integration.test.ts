import { expect } from "chai";
import type { AnalysisReport, ApplySuggestionsResult, DiffReport } from "@infralens/shared";
import { type ApiErrorResponse, defaultApiRequestLimits as limits } from "../src";
import { createAnalyzeLambdaHandler } from "../src/lambda";
import { example, localApi } from "./workflowFixtures";

const tinyTemplate = JSON.stringify({ Resources: { Queue: { Type: "AWS::SQS::Queue" } } });
const envelope = (extra: object) => JSON.stringify({ template: tinyTemplate, ...extra });
const failures = [
  { name: "missing body", path: "/analyze", body: undefined, status: 400, code: "MISSING_BODY", message: "body" },
  { name: "invalid template", path: "/analyze", body: '{"Resources":{"Broken":{}}}', status: 400, code: "INVALID_TEMPLATE", message: "CloudFormation" },
  { name: "oversized template", path: "/analyze", body: " ".repeat(limits.maxTemplateBytes) + tinyTemplate, status: 413, code: "PAYLOAD_TOO_LARGE", message: "template" },
  { name: "too many source files", path: "/analyze", body: envelope({ sourceFiles: Object.fromEntries(Array.from({ length: limits.maxSourceFiles + 1 }, (_, i) => [`file${i}.ts`, ""])) }), status: 413, code: "PAYLOAD_TOO_LARGE", message: "Source file count" },
  { name: "oversized source file in UTF-8 bytes", path: "/analyze", body: envelope({ sourceFiles: { "handler.ts": "é".repeat(Math.floor(limits.maxSourceFileBytes / 2) + 1) } }), status: 413, code: "PAYLOAD_TOO_LARGE", message: "Source file handler.ts" },
  { name: "invalid source mapping type", path: "/analyze", body: envelope({ sourceFiles: { "handler.ts": "" }, sourceFileMappings: { "handler.ts": 42 } }), status: 400, code: "INVALID_TEMPLATE", message: "sourceFileMappings" },
  { name: "empty mapping ID", path: "/analyze", body: envelope({ sourceFileMappings: { "handler.ts": " " } }), status: 400, code: "INVALID_TEMPLATE", message: "sourceFileMappings" },
  { name: "malformed diff JSON", path: "/diff", body: "{", status: 400, code: "INVALID_TEMPLATE", message: "JSON" },
  { name: "missing new diff template", path: "/diff", body: JSON.stringify({ oldTemplate: tinyTemplate }), status: 400, code: "INVALID_TEMPLATE", message: "newTemplate" },
  { name: "invalid nested diff template", path: "/diff", body: JSON.stringify({ oldTemplate: tinyTemplate, newTemplate: '{"Resources":{"Broken":{}}}' }), status: 400, code: "INVALID_TEMPLATE", message: "CloudFormation" },
  { name: "invalid selected fix", path: "/apply", body: envelope({ fixes: [{}] }), status: 400, code: "INVALID_FIX", message: "structured template fix" },
  { name: "oversized request envelope", path: "/analyze", body: envelope({ padding: "x".repeat(limits.maxRequestBytes) }), status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body" }
];

describe("Express / Lambda request contract integration", () => {
  const post = localApi({ requestLimits: limits });
  const handler = createAnalyzeLambdaHandler({ requestLimits: limits, writeLog: () => {} });

  for (const scenario of failures) {
    it(`rejects ${scenario.name} consistently across both adapters`, async () => {
      const http = await post<ApiErrorResponse>(scenario.path, scenario.body, scenario.status);
      const lambda = await handler({ httpMethod: "POST", path: scenario.path, body: scenario.body });
      expect(lambda.statusCode).to.equal(scenario.status);
      expect(lambda.headers["content-type"]).to.equal("application/json");
      for (const payload of [http, JSON.parse(lambda.body) as ApiErrorResponse]) {
        expect(payload).to.have.keys("error");
        expect(payload.error.code).to.equal(scenario.code);
        expect(payload.error.message.toLowerCase()).to.contain(scenario.message.toLowerCase());
      }
    });
  }

  it("passes the same real source analysis through Express and a base64 API Gateway event, then applies and compares", async () => {
    const template = example("order-service-risky-template.json");
    const body = JSON.stringify({ template,
      sourceFiles: { "createOrder.ts": example("shared-source-import-graph/sharedDb.ts") },
      sourceFileMappings: { "createOrder.ts": "OrderHandler" }
    });
    const httpReport = await post<AnalysisReport>("/analyze", body);
    const response = await handler({ httpMethod: "POST", path: "/production/analyze",
      body: Buffer.from(body).toString("base64"), isBase64Encoded: true });
    expect(response.statusCode).to.equal(200);
    const report = JSON.parse(response.body) as AnalysisReport;
    expect(report).to.deep.equal(httpReport);
    expect(report.leastPrivilegeSuggestions[0].suggestedActions).to.deep.equal(["dynamodb:PutItem"]);
    const fixes = report.templateFixes!.filter((f) => f.source.kind === "finding" && f.source.ruleId === "DYNAMODB_MISSING_PITR");
    expect(fixes).to.have.length(1);
    const applyResponse = await handler({ httpMethod: "POST", path: "/apply", body: JSON.stringify({ template, fixes }) });
    expect(applyResponse.statusCode).to.equal(200);
    const applied = JSON.parse(applyResponse.body) as ApplySuggestionsResult;
    expect(applied.appliedFixCount).to.equal(1);
    const diffBody = JSON.stringify({ oldTemplate: template, newTemplate: JSON.stringify(applied.modifiedTemplate) });
    const diffResponse = await handler({ httpMethod: "POST", path: "/diff", body: diffBody });
    expect(diffResponse.statusCode).to.equal(200);
    const diff = JSON.parse(diffResponse.body) as DiffReport;
    expect(diff).to.deep.equal(await post<DiffReport>("/diff", diffBody));
    expect(diff.findings.resolved.map((f) => f.ruleId)).to.deep.equal(["DYNAMODB_MISSING_PITR"]);
    expect(diff.resources.changed.map((r) => r.resourceId)).to.deep.equal(["OrdersTable"]);
  });
});

describe("unexpected analyzer failure contract integration", () => {
  // Only the exceptional analyzer boundary is injected: parsers, routes, logging and errors are real.
  const fail = () => { throw new Error("Synthetic analyzer failure"); };
  const post = localApi({ analyze: fail });
  const handler = createAnalyzeLambdaHandler({ analyze: fail, writeLog: () => {} });

  it("returns structured 500 errors from both adapters", async () => {
    const http = await post<ApiErrorResponse>("/analyze", tinyTemplate, 500);
    const lambda = await handler({ httpMethod: "POST", path: "/analyze", body: tinyTemplate });
    expect(lambda.statusCode).to.equal(500);
    expect(JSON.parse(lambda.body)).to.deep.equal(http);
    expect(http.error).to.deep.equal({ code: "ANALYSIS_ERROR",
      message: "Template analysis failed unexpectedly.", detail: "Synthetic analyzer failure" });
  });
});
