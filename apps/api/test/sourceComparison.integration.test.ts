import { expect } from "chai";
import { exportDiffReportToMarkdown, type DiffApiRequest, type DiffReport } from "@infralens/shared";
import { createAnalyzeLambdaHandler } from "../src/lambda";
import { defaultApiRequestLimits } from "../src/requestLimits";
import { example, localApi } from "./workflowFixtures";
import { createApplyComparison, serializeCompareRequest } from "../../web/src/compareInput";
import { diffCloudFormationBody } from "../src/analyzeRequest";

const fixture: DiffApiRequest = JSON.parse(example("compare/source-action-change.json"));

describe("source-aware API and web input workflow", () => {
  const post = localApi();
  const handler = createAnalyzeLambdaHandler({ writeLog: () => {} });

  it("returns the same explained code-only delta from Express and Lambda and exports it", async () => {
    const http = await post<DiffReport>("/diff", fixture);
    const lambda = await handler({ path: "/diff", httpMethod: "POST", body: JSON.stringify(fixture) });
    expect(lambda.statusCode).to.equal(200);
    expect(JSON.parse(lambda.body)).to.deep.equal(http);
    expect(http.source!.added[0].action).to.equal("dynamodb:PutItem");
    expect(http.suggestions!.changed[0].old.suggestedActions).to.deep.equal(["dynamodb:GetItem"]);
    expect(http.resources.changed).to.deep.equal([]);
    const output = exportDiffReportToMarkdown(http);
    for (const text of ["dynamodb:PutItem", "dynamodb:GetItem", "AppFunction", "OrdersTable", "Before:", "After:", "confidence", "not actual IAM permissions"])
      expect(output).to.contain(text);
  });

  it("preserves templates, source paths, mappings and exclusions through Apply navigation", () => {
    const source = { ...fixture.oldSource, sourceFileExclusions: ["src/helper.ts"] };
    const state = createApplyComparison(fixture.oldTemplate, fixture.newTemplate, source);
    expect(state.compareImmediately).to.equal(true);
    const request = serializeCompareRequest(state);
    expect(request.oldSource).to.deep.equal(source);
    expect(request.newSource).to.deep.equal(source);
    const diff = diffCloudFormationBody(JSON.stringify(request));
    expect(diff.source!.unchanged).to.have.length(1);
    expect(diff.suggestions!.changed).to.deep.equal([]);
    expect(serializeCompareRequest(createApplyComparison("old", "new"))).to.deep.equal({ oldTemplate: "old", newTemplate: "new" });
  });

  it("keeps template-only callers working and exposes missing source", async () => {
    const diff = await post<DiffReport>("/diff", { oldTemplate: fixture.oldTemplate, newTemplate: fixture.newTemplate });
    expect(diff.source!.old.status).to.equal("missing");
    expect(diff.source!.new.status).to.equal("missing");
    expect(diff.source!.added).to.deep.equal([]);
    expect(diff.suggestions!.changed).to.deep.equal([]);
  });
});

describe("source comparison validation across adapters", () => {
  const limits = { ...defaultApiRequestLimits, maxSourceFiles: 1, maxSourceFileBytes: 8,
    maxCombinedSourceBytes: 10, maxSourceMappings: 1, maxSourceExclusions: 1, maxRequestBytes: 4000 };
  const post = localApi({ requestLimits: limits });
  const handler = createAnalyzeLambdaHandler({ requestLimits: limits, writeLog: () => {} });
  const templates = { oldTemplate: '{"Resources":{}}', newTemplate: '{"Resources":{}}' };
  const failures = [
    { name: "context type", source: [], status: 400 },
    { name: "file type", source: { sourceFiles: { "a.ts": 7 } }, status: 400 },
    { name: "path traversal", source: { sourceFiles: { "../a.ts": "" } }, status: 400 },
    { name: "count", source: { sourceFiles: { "a.ts": "", "b.ts": "" } }, status: 413 },
    { name: "UTF-8 file bytes", source: { sourceFiles: { "a.ts": "ééééé" } }, status: 413 },
    { name: "mapping type", source: { sourceFileMappings: { "a.ts": 42 } }, status: 400 },
    { name: "mapping path", source: { sourceFileMappings: { "../a.ts": "App" } }, status: 400 },
    { name: "mapping count", source: { sourceFileMappings: { "a.ts": "App", "b.ts": "App" } }, status: 413 },
    { name: "exclusion path", source: { sourceFileExclusions: ["/a.ts"] }, status: 400 },
    { name: "exclusion count", source: { sourceFileExclusions: ["a.ts", "b.ts"] }, status: 413 }
  ];
  for (const side of ["oldSource", "newSource"]) for (const failure of failures) {
    it(`rejects ${side} ${failure.name} before analysis`, async () => {
      const body = JSON.stringify({ ...templates, [side]: failure.source });
      const http = await post("/diff", body, failure.status);
      const lambda = await handler({ path: "/diff", httpMethod: "POST", body });
      expect(lambda.statusCode).to.equal(failure.status);
      expect(JSON.parse(lambda.body)).to.deep.equal(http);
    });
  }
  it("limits combined bytes without conflating identical paths on two sides", async () => {
    const source = { sourceFiles: { "a.ts": "ééé" } };
    const body = JSON.stringify({ ...templates, oldSource: source, newSource: source });
    await post("/diff", body, 413);
    expect((await handler({ path: "/diff", httpMethod: "POST", body })).statusCode).to.equal(413);
    const accepted = await post<DiffReport>("/diff", { ...templates,
      oldSource: { sourceFiles: { "a.ts": "" } }, newSource: { sourceFiles: { "a.ts": "" } } });
    expect(accepted.source!.old.fileCount).to.equal(1);
    expect(accepted.source!.new.fileCount).to.equal(1);
  });
  it("enforces the total serialized request budget", async () => {
    await post("/diff", { ...templates, padding: "x".repeat(limits.maxRequestBytes) }, 413);
  });
});
