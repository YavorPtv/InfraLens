import { expect } from "chai";
import { describe, it } from "mocha";
import type {
  AnalysisReport,
  OpenSavedRun,
  SavedProject,
  SaveAnalysisRequest
} from "@infralens/shared";
import { HistoryService, type HistoryServiceOptions } from "../src/historyService";
import {
  MemoryArtifactStore,
  MemoryHistoryStore,
  type ArtifactStore,
  type RunRecord,
  type StoredRecord,
  type Write
} from "../src/historyStore";
import { createAnalyzeLambdaHandler } from "../src/lambda";
import { ApiRequestError } from "../src/analyzeRequest";
import { configuredHistory, localHistoryOwner } from "../src/historyConfig";
import { createHistoryClient, restoreSavedReport } from "../../web/src/api/historyClient";
import { createApiApp } from "../src/index";
import type { AddressInfo } from "node:net";
import { example } from "./workflowFixtures";
import type { DiffApiRequest, DiffReport } from "@infralens/shared";
import { exportAnalysisReportToMarkdown, exportDiffReportToMarkdown } from "@infralens/shared";

const template = JSON.stringify({ Resources: { Bucket: { Type: "AWS::S3::Bucket" } } });

const request = (key = "save-key-one"): SaveAnalysisRequest => ({
  input: { template },
  idempotencyKey: key
});

function setup(options: HistoryServiceOptions = {}) {
  const store = new MemoryHistoryStore();
  const artifacts = new MemoryArtifactStore();
  let time = Date.parse("2026-09-26T12:00:00.000Z");
  const history = new HistoryService(store, artifacts, {
    ...options,
    now: () => time
  });
  const handler = createAnalyzeLambdaHandler({
    history,
    writeLog: () => {}
  });
  const api = async (
    owner: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>
  ) => {
    const result = await handler({
      path,
      httpMethod: method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      requestContext: { authorizer: { claims: { sub: owner } } },
      queryStringParameters: query
    });
    return {
      status: result.statusCode,
      body: JSON.parse(result.body)
    };
  };
  return {
    store,
    artifacts,
    history,
    api,
    handler,
    advance: (ms: number) => {
      time += ms;
    }
  };
}

async function rejects(action: Promise<unknown>, status: number) {
  try {
    await action;
    expect.fail("Expected rejection");
  } catch (error) {
    expect(error).to.be.instanceOf(ApiRequestError);
    expect((error as ApiRequestError).statusCode).to.equal(status);
  }
}

describe("saved projects and analysis history", () => {
  it("saves summaries/versions and completes fresh-client reopen -> apply child -> compare -> export", async () => {
    const context = setup();
    const fetcher: typeof fetch = async (url, init) => {
      const result = await context.handler({ path: new URL(String(url)).pathname,
        httpMethod: init?.method ?? "GET", body: init?.body as string | undefined,
        requestContext: { authorizer: { claims: { sub: "alice" } } } });
      return new Response(result.body, { status: result.statusCode });
    };
    const first = createHistoryClient("https://api.example", fetcher);
    const project = await first.create("child workflow");
    const source = { sourceFiles: { "handler.ts": example("shared-source-import-graph/sharedDb.ts") },
      sourceFileMappings: { "handler.ts": "OrderHandler" }, sourceFileExclusions: [] };
    const original = await first.save(project.projectId, { input: { template: example("order-service-risky-template.json"), ...source }, retainSource: true, idempotencyKey: "parent-workflow" });
    const fresh = createHistoryClient("https://api.example", fetcher);
    const reopened = await fresh.open(project.projectId, original.run.runId);
    const listed = (await fresh.runs(project.projectId)).items[0];
    expect(listed.summary).to.deep.equal(reopened.report.summary);
    expect(listed.resourceCount).to.equal(reopened.report.resources.length);
    expect(listed.analyzerVersion).to.equal("0.2.0");
    expect(listed.schemaVersion).to.equal("2");
    const fixIds = reopened.report.templateFixes!.filter(fix => fix.applicability === "applicable" &&
      (fix.source.kind === "least-privilege" || fix.source.ruleId === "DYNAMODB_MISSING_PITR")).map(fix => fix.id);
    expect(fixIds).to.have.length(2);
    const body = { fixIds, retainSource: true, idempotencyKey: "child-workflow" };
    const child = await fresh.apply(project.projectId, original.run.runId, body);
    expect(child.run.provenance).to.deep.equal({ kind: "apply", parentRun: { projectId: project.projectId, runId: original.run.runId }, inputMode: "retained", appliedFixIds: fixIds });
    expect(child.run.runId).to.not.equal(original.run.runId);
    expect(child.input!.sourceFiles).to.deep.equal(source.sourceFiles);
    expect(child.input!.sourceFileMappings).to.deep.equal(source.sourceFileMappings);
    expect(child.input!.sourceFileExclusions).to.deep.equal(source.sourceFileExclusions);
    expect((await fresh.apply(project.projectId, original.run.runId, body)).run.runId).to.equal(child.run.runId);
    expect((await fresh.open(project.projectId, original.run.runId)).report).to.deep.equal(original.report);
    const reference = (run: typeof child.run) => ({ projectId: run.projectId, runId: run.runId });
    const diff = await fresh.compare(reference(original.run), reference(child.run));
    expect(diff.resources.changed.map(resource => resource.resourceId)).to.have.members(["OrdersTable", "OrderHandlerRole"]);
    expect(diff.source!.unchanged).to.have.length.greaterThan(0);
    expect(diff.findings.resolved.some(finding => finding.ruleId === "DYNAMODB_MISSING_PITR")).to.equal(true);
    expect(exportDiffReportToMarkdown(diff)).to.include("does not replay historical saved output");
    expect(exportAnalysisReportToMarkdown(child.report)).to.include("Analyzer: 0.2.0; report schema: 2");
    context.advance(7 * 86400_000);
    expect((await fresh.apply(project.projectId, original.run.runId, body)).run.runId).to.equal(child.run.runId);
  });

  it("keeps legacy records/reports readable with explicitly unknown versions and comparison warnings", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "legacy");
    const saved = await context.history.save("alice", project.projectId, request("legacy-parent"));
    const key = { pk: `OWNER#alice#PROJECT#${project.projectId}`, sk: `RUN#${saved.run.runId}` };
    const record = (await context.store.runs.get<RunRecord>(key))!;
    const legacy = { ...record };
    for (const field of ["analyzerVersion", "schemaVersion", "summary", "score", "resourceCount", "inputDigest", "templateDigest", "sourceStatus"] as const) delete legacy[field];
    await context.store.commit([{ table: "runs", item: { ...legacy, version: record.version + 1 }, expected: record.version }]);
    const report = { ...saved.report };
    delete report.analyzerVersion;
    delete report.schemaVersion;
    await context.artifacts.put(record.artifacts.report, JSON.stringify(report));
    const reopened = await context.history.open("alice", project.projectId, saved.run.runId);
    expect(reopened.report.analyzerVersion).to.equal("unknown");
    expect(reopened.report.schemaVersion).to.equal("unknown");
    expect((await context.history.listRuns("alice", project.projectId, 20)).items[0]).to.include({ analyzerVersion: "unknown", schemaVersion: "unknown" });
    const current = await context.history.save("alice", project.projectId, request("current-version"));
    const comparison = await context.history.compare("alice", saved.run, current.run);
    expect(comparison.savedComparison!.old.analyzerVersion).to.equal("unknown");
    expect(comparison.savedComparison!.warnings.join(" ")).to.include("Historical finding counts");
    expect(comparison.newReport.analyzerVersion).to.equal("0.2.0");
  });

  it("explicitly reanalyzes, preserves retained context and requires reupload or template-only for missing source", async () => {
    const context = setup();
    const fixture: DiffApiRequest = JSON.parse(example("compare/source-action-change.json"));
    const project = await context.history.createProject("alice", "reanalysis");
    const input = { template: fixture.oldTemplate, ...fixture.oldSource };
    const retained = await context.history.save("alice", project.projectId, { input, retainSource: true, idempotencyKey: "retained-reanalysis" });
    const child = await context.history.derive("alice", project.projectId, retained.run.runId, "reanalysis", { idempotencyKey: "new-reanalysis", retainSource: true });
    expect(child.input).to.deep.equal(retained.input);
    expect(child.run.provenance!.kind).to.equal("reanalysis");
    expect(child.run.analyzerVersion).to.equal("0.2.0");
    const unretained = await context.history.save("alice", project.projectId, { input, idempotencyKey: "unretained-reanalysis" });
    const path = `/projects/${project.projectId}/runs/${unretained.run.runId}/reanalyze`;
    expect((await context.api("alice", "POST", path, { idempotencyKey: "source-missing" })).status).to.equal(400);
    const templateOnly = await context.api("alice", "POST", path, { idempotencyKey: "template-only", templateOnly: true });
    expect(templateOnly.status).to.equal(201);
    expect(templateOnly.body.report.sourceAnalysis.status).to.equal("missing");
    expect(templateOnly.body.run.provenance.inputMode).to.equal("template-only");
    const uploaded = await context.api("alice", "POST", path, { idempotencyKey: "source-reuploaded", input, retainSource: true });
    expect(uploaded.status).to.equal(201);
    expect(uploaded.body.input).to.deep.equal(retained.input);
    expect(uploaded.body.run.provenance.inputMode).to.equal("reuploaded");
    context.advance(7 * 86400_000);
    expect((await context.api("alice", "POST", path, { idempotencyKey: "expired-reanalysis", templateOnly: true })).status).to.equal(410);
    expect((await context.api("alice", "POST", path, { idempotencyKey: "expired-reupload", input, retainSource: true })).status).to.equal(201);
  });

  it("rejects cross-owner/deleted parents, fabricated/stale fixes, extra fields and changed Apply reuploads", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "protected parent");
    const saved = await context.history.save("alice", project.projectId, request("protected-parent"));
    const fixIds = saved.report.templateFixes!.filter(fix => fix.applicability === "applicable").map(fix => fix.id);
    const path = `/projects/${project.projectId}/runs/${saved.run.runId}/apply`;
    const body = { idempotencyKey: "protected-child", fixIds };
    expect(fixIds.length).to.be.greaterThan(0);
    expect((await context.api("bob", "POST", path, body)).status).to.equal(404);
    for (const extra of [{ report: saved.report }, { parentRun: saved.run }, { fixes: saved.report.templateFixes }, { templateOnly: "yes" }, { fixIds: [] }, { fixIds: [fixIds[0], fixIds[0]] }, { input: null }]) {
      expect((await context.api("alice", "POST", path, { ...body, ...extra })).status).to.equal(400);
    }
    expect((await context.api("alice", "POST", path, { ...body, fixIds: ["invented"] })).status).to.equal(409);
    expect((await context.api("alice", "POST", path, { ...body, input: { template: template + " " } })).status).to.equal(409);
    const key = { pk: `OWNER#alice#PROJECT#${project.projectId}`, sk: `RUN#${saved.run.runId}` };
    const record = (await context.store.runs.get<RunRecord>(key))!;
    const staleReport = structuredClone(saved.report);
    staleReport.templateFixes!.find(fix => fix.id === fixIds[0])!.patches[0].value = false;
    await context.artifacts.put(record.artifacts.report, JSON.stringify(staleReport));
    expect((await context.api("alice", "POST", path, body)).status).to.equal(409);
    await context.history.deleteRun("alice", project.projectId, saved.run.runId);
    expect((await context.api("alice", "POST", path, body)).status).to.equal(404);
  });

  it("keeps child saves quota-bound, retry-safe after failed uploads and inaccessible during parent deletion", async () => {
    const limited = setup({ quotas: { runsPerProject: 1 } });
    const project = await limited.history.createProject("alice", "quota");
    const parent = await limited.history.save("alice", project.projectId, request("quota-parent"));
    await rejects(limited.history.derive("alice", project.projectId, parent.run.runId, "reanalysis", { idempotencyKey: "quota-child" }), 409);
    expect((await limited.history.listRuns("alice", project.projectId, 20)).items).to.have.length(1);

    const context = setup();
    const p = await context.history.createProject("alice", "recovery");
    const original = await context.history.save("alice", p.projectId, request("recovery-parent"));
    const put = context.artifacts.put.bind(context.artifacts);
    context.artifacts.put = async () => { throw new Error("Temporary upload failure"); };
    try { await context.history.derive("alice", p.projectId, original.run.runId, "reanalysis", { idempotencyKey: "recovery-child" }); expect.fail("Expected upload failure"); }
    catch (error) { expect((error as Error).message).to.equal("Temporary upload failure"); }
    expect((await context.history.listRuns("alice", p.projectId, 20)).items).to.have.length(1);
    context.artifacts.put = put;
    context.advance(120_001);
    const recovered = await context.history.derive("alice", p.projectId, original.run.runId, "reanalysis", { idempotencyKey: "recovery-child" });
    expect((await context.history.listRuns("alice", p.projectId, 20)).items).to.have.length(2);
    expect((await context.history.derive("alice", p.projectId, original.run.runId, "reanalysis", { idempotencyKey: "recovery-child" })).run.runId).to.equal(recovered.run.runId);
    await rejects(context.history.derive("alice", p.projectId, original.run.runId, "reanalysis", { idempotencyKey: "recovery-child", templateOnly: true }), 409);
    let deleted = false;
    context.artifacts.put = async (key, body) => {
      await put(key, body);
      if (!deleted) {
        deleted = true;
        await context.history.deleteRun("alice", p.projectId, original.run.runId);
      }
    };
    await rejects(context.history.derive("alice", p.projectId, original.run.runId, "reanalysis", { idempotencyKey: "deleted-parent-child" }), 404);
    expect((await context.history.listRuns("alice", p.projectId, 20)).items.map(run => run.runId)).to.deep.equal([recovered.run.runId]);
    context.advance(120_001);
    await context.history.cleanup("alice", 20);
    await context.history.deleteRun("alice", p.projectId, recovered.run.runId);
    expect(context.artifacts.objects.size).to.equal(0);
  });

  it("requires original source for source-dependent Apply and verifies expired reuploads without reviving deleted children", async () => {
    const context = setup();
    const fixture: DiffApiRequest = JSON.parse(example("compare/source-action-change.json"));
    const project = await context.history.createProject("alice", "expired apply");
    const input = { template: fixture.oldTemplate, ...fixture.oldSource };
    const saved = await context.history.save("alice", project.projectId, { input, idempotencyKey: "source-apply-parent" });
    const fixIds = saved.report.templateFixes!.filter(fix => fix.source.kind === "least-privilege" && fix.applicability === "applicable").map(fix => fix.id);
    expect(fixIds.length).to.be.greaterThan(0);
    const path = `/projects/${project.projectId}/runs/${saved.run.runId}/apply`;
    expect((await context.api("alice", "POST", path, { fixIds, idempotencyKey: "missing-source-apply" })).status).to.equal(400);
    expect((await context.api("alice", "POST", path, { fixIds, idempotencyKey: "template-source-apply", templateOnly: true })).status).to.equal(409);
    context.advance(7 * 86400_000);
    expect((await context.api("alice", "POST", path, { fixIds, idempotencyKey: "expired-source-apply", templateOnly: true })).status).to.equal(410);
    const body = { fixIds, idempotencyKey: "reuploaded-source-apply", input, retainSource: true };
    const response = await context.api("alice", "POST", path, body);
    expect(response.status).to.equal(201);
    const child = response.body as OpenSavedRun;
    expect(child.run.provenance!.inputMode).to.equal("reuploaded");
    expect(child.input!.sourceFiles).to.deep.equal(input.sourceFiles);
    expect((await context.history.open("alice", project.projectId, saved.run.runId)).input).to.equal(undefined);
    await context.history.deleteRun("alice", project.projectId, child.run.runId);
    expect((await context.api("alice", "POST", path, body)).status).to.equal(410);
  });

  it("compares retained source independently, labels unretained source and rejects expiry/other owners/deletion", async () => {
    const context = setup();
    const fixture: DiffApiRequest = JSON.parse(example("compare/source-action-change.json"));
    const project = await context.history.createProject("alice", "source comparison");
    const save = (key: string, source: DiffApiRequest["oldSource"], retainSource = true) =>
      context.history.save("alice", project.projectId, { input: { template: fixture.oldTemplate, ...source }, idempotencyKey: key, retainSource });
    const oldRun = await save("source-read", fixture.oldSource);
    const newRun = await save("source-write", fixture.newSource);
    const response = await context.api("alice", "POST", "/projects/compare", { oldRun: oldRun.run, newRun: newRun.run });
    // Route references intentionally allow IDs only, not run metadata.
    expect(response.status).to.equal(400);
    const reference = (run: typeof oldRun.run) => ({ projectId: run.projectId, runId: run.runId });
    const compared = await context.api("alice", "POST", "/projects/compare", { oldRun: reference(oldRun.run), newRun: reference(newRun.run) });
    expect(compared.status).to.equal(200);
    const diff = compared.body as DiffReport;
    expect(diff.source!.added[0].action).to.equal("dynamodb:PutItem");
    expect(diff.suggestions!.changed[0].old.suggestedActions).to.deep.equal(["dynamodb:GetItem"]);
    expect((await context.history.open("alice", project.projectId, oldRun.run.runId)).input!.sourceFileMappings).to.deep.equal(fixture.oldSource!.sourceFileMappings);
    const noSource = await save("source-not-retained", fixture.newSource, false);
    expect((await context.history.open("alice", project.projectId, noSource.run.runId)).input).to.deep.equal({ template: fixture.oldTemplate });
    const missing = await context.history.compare("alice", oldRun.run, noSource.run);
    expect(missing.source!.new.status).to.equal("missing");
    expect(missing.source!.warnings.join(" ")).to.include("reupload source");
    const empty = await save("source-empty", { sourceFiles: {} });
    expect(empty.run.sourceRetained).to.equal(true);
    expect((await context.history.compare("alice", oldRun.run, empty.run)).source!.new.status).to.equal("provided");
    await rejects(context.history.compare("bob", oldRun.run, newRun.run), 404);
    await context.history.deleteRun("alice", project.projectId, newRun.run.runId);
    await rejects(context.history.compare("alice", oldRun.run, newRun.run), 404);
    context.advance(7 * 86400_000);
    await rejects(context.history.compare("alice", oldRun.run, noSource.run), 410);
    expect((await context.history.open("alice", project.projectId, oldRun.run.runId)).input).to.equal(undefined);
  });

  it("preserves retained exclusions during comparison and clears previous source on restore", async () => {
    const context = setup();
    const fixture: DiffApiRequest = JSON.parse(example("compare/source-action-change.json"));
    const project = await context.history.createProject("alice", "exclusions");
    const first = await context.history.save("alice", project.projectId, { input: { template: fixture.oldTemplate, ...fixture.oldSource }, retainSource: true, idempotencyKey: "retained-before" });
    const second = await context.history.save("alice", project.projectId, { input: { template: fixture.newTemplate, ...fixture.newSource, sourceFileExclusions: ["src/handler.ts"] }, retainSource: true, idempotencyKey: "retained-after" });
    const diff = await context.history.compare("alice", first.run, second.run);
    expect(diff.source!.old.actions).to.have.length(1);
    expect(diff.source!.new.actions).to.deep.equal([]);
    const reopened = await context.history.open("alice", project.projectId, second.run.runId);
    let restored: unknown = fixture.oldSource;
    await restoreSavedReport({ open: async () => reopened }, project.projectId, second.run.runId,
      { setReport: () => {}, setOriginalTemplateInput: () => {}, setOriginalSource: value => { restored = value; } });
    expect(restored).to.deep.equal({ ...fixture.newSource, sourceFileExclusions: ["src/handler.ts"] });
    context.advance(7 * 86400_000);
    const expired = await context.history.open("alice", project.projectId, second.run.runId);
    await restoreSavedReport({ open: async () => expired }, project.projectId, second.run.runId,
      { setReport: () => {}, setOriginalTemplateInput: () => {}, setOriginalSource: value => { restored = value; } });
    expect(restored).to.equal(undefined);
  });
  it("creates, lists, renames and deletes owner-scoped projects with generated IDs", async () => {
    const context = setup();
    const created = await context.api("alice", "POST", "/projects", { name: " First " });
    expect(created.status).to.equal(201);
    const id = created.body.projectId;
    expect(id).to.match(/^[0-9a-f-]{36}$/);
    expect((await context.api("alice", "GET", "/projects")).body.items).to.deep.equal([
      created.body
    ]);
    expect((await context.api("bob", "GET", "/projects")).body.items).to.deep.equal([]);
    expect(
      (await context.api("bob", "PATCH", `/projects/${id}`, { name: "stolen" })).status
    ).to.equal(404);
    expect((await context.api("bob", "DELETE", `/projects/${id}`)).status).to.equal(404);
    expect(
      (await context.api("alice", "PATCH", `/projects/${id}`, { name: "renamed" })).body.name
    ).to.equal("renamed");
    expect((await context.api("alice", "DELETE", `/projects/${id}`)).status).to.equal(200);
    expect((await context.api("alice", "GET", "/projects")).body.items).to.deep.equal([]);
    expect((await context.api("alice", "POST", `/projects/${id}/runs`, request())).status).to.equal(
      404
    );
  });

  it("requires trusted sub, ignoring header tokens and rejecting browser identity/report/object keys", async () => {
    const context = setup();
    expect((await context.api(undefined, "GET", "/projects")).status).to.equal(401);
    const forged = await context.handler({
      path: "/projects",
      httpMethod: "GET",
      headers: {
        Authorization: "Bearer fake",
        "x-owner-id": "alice"
      }
    });
    expect(forged.statusCode).to.equal(401);
    for (const extra of [{ ownerId: "bob" }, { userId: "bob" }, { projectId: "chosen" }]) {
      expect(
        (
          await context.api("alice", "POST", "/projects", {
            name: "p",
            ...extra
          })
        ).status
      ).to.equal(400);
    }
    const project = await context.history.createProject("alice", "p");
    for (const extra of [{ report: {} }, { objectKey: "secret" }, { ownerId: "bob" }]) {
      expect(
        (
          await context.api("alice", "POST", `/projects/${project.projectId}/runs`, {
            ...request(),
            ...extra
          })
        ).status
      ).to.equal(400);
    }
  });

  it("analyzes on the server and authorizes every run/artifact/comparison independently", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const bobsProject = await context.history.createProject("bob", "b");
    const firstRun = await context.history.save("alice", project.projectId, request());
    const other = await context.history.save("bob", bobsProject.projectId, request());
    expect(firstRun.report.resources).to.have.length(1);
    expect(
      (await context.history.open("alice", project.projectId, firstRun.run.runId)).report
    ).to.deep.equal(firstRun.report);
    const path = `/projects/${project.projectId}/runs/${firstRun.run.runId}`;
    for (const [method, route] of [
      ["GET", path],
      ["DELETE", path],
      ["GET", `${path}/artifacts/report`],
      ["GET", `/projects/${project.projectId}/runs`]
    ]) {
      expect((await context.api("bob", method, route)).status).to.equal(404);
    }
    expect((await context.api("alice", "GET", `${path}/artifacts/report`)).body.contents).to.equal(
      JSON.stringify(firstRun.report)
    );
    await rejects(context.history.compare("alice", firstRun.run, other.run), 404);
    await rejects(context.history.compare("alice", other.run, firstRun.run), 404);
    expect(
      (await context.history.compare("alice", firstRun.run, firstRun.run)).resources.added
    ).to.deep.equal([]);
  });

  it("paginates chronologically with opaque, scoped, authenticated and expiring cursors", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const secondProject = await context.history.createProject("alice", "q");
    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(
        (await context.history.save("alice", project.projectId, request(`save-key-${i}`))).run.runId
      );
      context.advance(1);
    }
    const first = await context.history.listRuns("alice", project.projectId, 1);
    expect(first.items.map((result) => result.runId)).to.deep.equal(runs.slice(0, 1));
    expect(first.nextCursor).to.be.a("string");
    expect(Buffer.from(first.nextCursor!, "base64url").toString()).not.to.contain("OWNER#");
    await rejects(
      context.history.listRuns("alice", secondProject.projectId, 1, first.nextCursor),
      400
    );
    const bp = await context.history.createProject("bob", "b");
    await rejects(context.history.listRuns("bob", bp.projectId, 1, first.nextCursor), 400);
    await rejects(context.history.listProjects("alice", 1, first.nextCursor), 400);
    await rejects(
      context.history.listRuns("alice", project.projectId, 1, "x" + first.nextCursor!.slice(1)),
      400
    );
    const second = await context.history.listRuns("alice", project.projectId, 1, first.nextCursor);
    const third = await context.history.listRuns("alice", project.projectId, 1, second.nextCursor);
    expect(
      [...first.items, ...second.items, ...third.items].map((result) => result.runId)
    ).to.deep.equal(runs);
    expect(third.nextCursor).to.equal(undefined);
    context.advance(3600_001);
    await rejects(context.history.listRuns("alice", project.projectId, 1, first.nextCursor), 400);
  });

  it("makes sequential and concurrent duplicate saves retry-safe and conflicts on changed input", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const results = await Promise.allSettled([
      context.history.save("alice", project.projectId, request()),
      context.history.save("alice", project.projectId, request())
    ]);
    expect(results.some((result) => result.status === "fulfilled")).to.equal(true);
    const saved = await context.history.save("alice", project.projectId, request());
    expect((await context.history.save("alice", project.projectId, request())).run.runId).to.equal(
      saved.run.runId
    );
    expect((await context.history.listRuns("alice", project.projectId, 10)).items).to.have.length(
      1
    );
    await rejects(
      context.history.save("alice", project.projectId, {
        ...request(),
        retainSource: true
      }),
      409
    );
    await rejects(
      context.history.save("alice", project.projectId, {
        ...request(),
        input: { template: template + " " }
      }),
      409
    );
    const secondProject = await context.history.createProject("alice", "q");
    await rejects(context.history.save("alice", secondProject.projectId, request()), 409);
    const bobsProject = await context.history.createProject("bob", "b");
    await context.history.save("bob", bobsProject.projectId, request());
  });

  it("hashes object fields deterministically", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const firstRun = await context.history.save("alice", project.projectId, {
      ...request(),
      input: {
        template,
        sourceFiles: {
          "a.ts": "",
          "b.ts": ""
        }
      }
    });
    const secondRun = await context.history.save("alice", project.projectId, {
      ...request(),
      input: {
        sourceFiles: {
          "b.ts": "",
          "a.ts": ""
        },
        template
      }
    });
    expect(firstRun.run.runId).to.equal(secondRun.run.runId);
  });

  it("keeps failed artifact writes invisible and recovers the same run after the lease", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const put = context.artifacts.put.bind(context.artifacts);
    let writes = 0;
    context.artifacts.put = async (key, body) => {
      if (++writes === 2) {
        throw new Error("S3 failure");
      }
      await put(key, body);
    };
    expect(
      (await context.api("alice", "POST", `/projects/${project.projectId}/runs`, request())).status
    ).to.equal(500);
    expect((await context.history.listRuns("alice", project.projectId, 10)).items).to.deep.equal(
      []
    );
    expect(context.artifacts.objects.size).to.equal(1);
    const pending = (
      await context.store.runs.query<RunRecord>(
        `OWNER#alice#PROJECT#${project.projectId}`,
        "RUN#",
        10
      )
    ).items[0];
    await rejects(context.history.open("alice", project.projectId, pending.runId), 404);
    await rejects(context.history.save("alice", project.projectId, request()), 409);
    context.advance(120_001);
    context.artifacts.put = put;
    const saved = await context.history.save("alice", project.projectId, request());
    expect(saved.run.runId).to.equal(pending.runId);
    expect(context.artifacts.objects.size).to.equal(3);
    expect(
      [...context.artifacts.objects.keys()].some((key) =>
        Object.values(pending.artifacts).includes(key)
      )
    ).to.equal(false);
  });
  for (const phase of ["reservation", "publication", "ambiguous-publication"] as const) {
    it(`handles ${phase} metadata failure without duplicates or unsafe artifact removal`, async () => {
      const context = setup();
      const project = await context.history.createProject("alice", "p");
      const commit = context.store.commit.bind(context.store);
      context.store.commit = async (writes: Write[]) => {
        const target = writes.some(
          (writeOperation) =>
            writeOperation.table === "runs" &&
            (writeOperation.item as RunRecord).state ===
              (phase === "reservation" ? "pending" : "completed")
        );
        if (target) {
          if (phase === "ambiguous-publication") {
            await commit(writes);
          }
          throw new Error("DDB failure");
        }
        return commit(writes);
      };
      expect(
        (await context.api("alice", "POST", `/projects/${project.projectId}/runs`, request()))
          .status
      ).to.equal(500);
      const list = await context.history.listRuns("alice", project.projectId, 10);
      expect(list.items.length).to.equal(phase === "ambiguous-publication" ? 1 : 0);
      expect(context.artifacts.objects.size).to.equal(phase === "reservation" ? 0 : 3);
      context.store.commit = commit;
      context.advance(120_001);
      const saved = await context.history.save("alice", project.projectId, request());
      expect(
        (await context.history.open("alice", project.projectId, saved.run.runId)).report
      ).to.deep.equal(saved.report);
      expect((await context.history.listRuns("alice", project.projectId, 10)).items).to.have.length(
        1
      );
    });
  }
  it("immediately revokes deleted runs, retries failed cleanup and preserves idempotency tombstones", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const result = await context.history.save("alice", project.projectId, request());
    const remove = context.artifacts.delete.bind(context.artifacts);
    context.artifacts.delete = async () => {
      throw new Error("S3 deletion failure");
    };
    expect(
      (await context.history.deleteRun("alice", project.projectId, result.run.runId)).cleanupPending
    ).to.equal(true);
    await rejects(context.history.open("alice", project.projectId, result.run.runId), 404);
    await rejects(
      context.history.download("alice", project.projectId, result.run.runId, "report"),
      404
    );
    await rejects(context.history.save("alice", project.projectId, request()), 410);
    context.artifacts.delete = remove;
    expect((await context.history.cleanup("alice", 20)).cleanupPending).to.equal(false);
    expect(context.artifacts.objects.size).to.equal(0);
  });

  it("prevents publication during project deletion and cleans a late in-flight upload after its lease", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const put = context.artifacts.put.bind(context.artifacts);
    let deleted = false;
    context.artifacts.put = async (key, body) => {
      if (!deleted) {
        deleted = true;
        expect(
          (await context.history.deleteProject("alice", project.projectId)).cleanupPending
        ).to.equal(true);
      }
      await put(key, body);
    };
    await rejects(context.history.save("alice", project.projectId, request()), 404);
    expect(context.artifacts.objects.size).to.equal(3);
    await rejects(context.history.listRuns("alice", project.projectId, 10), 404);
    context.advance(120_001);
    expect(
      (await context.history.deleteProject("alice", project.projectId)).cleanupPending
    ).to.equal(false);
    expect(context.artifacts.objects.size).to.equal(0);
  });

  it("retains templates for seven days, defaults to no source, and enforces expiry before lifecycle cleanup", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const source = { "handler.ts": "export const handler = () => 1;" };
    const firstRun = await context.history.save("alice", project.projectId, {
      ...request(),
      input: {
        template,
        sourceFiles: source
      }
    });
    expect(firstRun.run.sourceRetained).to.equal(false);
    expect(firstRun.run.inputExpiresAt).to.equal("2026-10-03T12:00:00.000Z");
    const retained = await context.history.download(
      "alice",
      project.projectId,
      firstRun.run.runId,
      "input"
    );
    expect(JSON.parse((retained as { contents: string }).contents)).to.deep.equal({ template });
    const secondRun = await context.history.save("alice", project.projectId, {
      ...request("source-opt-in"),
      input: {
        template,
        sourceFiles: source
      },
      retainSource: true
    });
    expect(secondRun.run.sourceRetained).to.equal(true);
    expect(
      JSON.parse(
        (
          (await context.history.download(
            "alice",
            project.projectId,
            secondRun.run.runId,
            "input"
          )) as {
            contents: string;
          }
        ).contents
      ).sourceFiles
    ).to.deep.equal(source);
    context.advance(7 * 86400_000);
    expect(
      (await context.history.open("alice", project.projectId, firstRun.run.runId)).template
    ).to.equal(undefined);
    await rejects(
      context.history.download("alice", project.projectId, firstRun.run.runId, "input"),
      410
    );
    await rejects(context.history.compare("alice", firstRun.run, secondRun.run), 410);
    expect(
      (await context.history.open("alice", project.projectId, firstRun.run.runId)).report
    ).to.deep.equal(firstRun.report);
  });

  it("enforces project/run/input quotas atomically and never silently removes reports", async () => {
    const context = setup({
      quotas: {
        projectsPerUser: 1,
        runsPerProject: 1,
        runsPerUser: 1,
        retainedInputBytes: 1000
      }
    });
    const created = await Promise.allSettled([
      context.history.createProject("alice", "one"),
      context.history.createProject("alice", "two")
    ]);
    expect(created.filter((result) => result.status === "fulfilled")).to.have.length(1);
    const project = (
      created.find(
        (result) => result.status === "fulfilled"
      ) as PromiseFulfilledResult<SavedProject>
    ).value;
    const saved = await Promise.allSettled([
      context.history.save("alice", project.projectId, request("quota-one")),
      context.history.save("alice", project.projectId, request("quota-two"))
    ]);
    expect(saved.filter((result) => result.status === "fulfilled")).to.have.length(1);
    expect((await context.history.listRuns("alice", project.projectId, 10)).items).to.have.length(
      1
    );
    const run = (
      saved.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<OpenSavedRun>
    ).value;
    await context.history.deleteRun("alice", project.projectId, run.run.runId);
    await context.history.save("alice", project.projectId, request("quota-new"));
    await rejects(
      context.history.save("alice", project.projectId, {
        ...request("large-input"),
        input: {
          template,
          sourceFiles: { "large.ts": "x".repeat(1000) }
        },
        retainSource: true
      }),
      413
    );
  });

  it("restores the same saved report through a fresh client and empty report state", async () => {
    const context = setup();
    const fetcher: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      const result = await context.handler({
        path: parsed.pathname,
        httpMethod: init?.method ?? "GET",
        body: init?.body as string | undefined,
        requestContext: { authorizer: { claims: { sub: "alice" } } },
        queryStringParameters: Object.fromEntries(parsed.searchParams)
      });
      return new Response(result.body, {
        status: result.statusCode,
        headers: result.headers
      });
    };
    const first = createHistoryClient("https://api.example", fetcher);
    const project = await first.create("persisted");
    const saved = await first.save(project.projectId, request());
    const second = createHistoryClient("https://api.example", fetcher);
    let report: AnalysisReport | null = null;
    let input: string | null = null;
    const projects = await second.projects();
    const runs = await second.runs(projects.items[0].projectId);
    await restoreSavedReport(second, project.projectId, runs.items[0].runId, {
      setReport: (result) => {
        report = result;
      },
      setOriginalTemplateInput: (templateInput) => {
        input = templateInput;
      }
    });
    expect(report).to.deep.equal(saved.report);
    expect(input).to.equal(template);
  });

  it("does not enable a fake identity or memory adapter in production/Lambda", () => {
    expect(() =>
      localHistoryOwner({
        INFRALENS_LOCAL_OWNER: "alice",
        INFRALENS_ENVIRONMENT: "production"
      })
    ).to.throw("Local identity");
    expect(() =>
      configuredHistory(true, {
        INFRALENS_HISTORY_ADAPTER: "memory",
        INFRALENS_ENVIRONMENT: "development"
      })
    ).to.throw("local-only");
    expect(
      localHistoryOwner({
        INFRALENS_LOCAL_OWNER: "alice",
        INFRALENS_ENVIRONMENT: "development",
        INFRALENS_HISTORY_ADAPTER: "memory"
      })
    ).to.equal("alice");
  });

  it("uses signed downloads only after authorization and bounds them to input expiry", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const result = await context.history.save("alice", project.projectId, request());
    const signed: Array<{
      key: string;
      seconds: number;
    }> = [];
    const adapter: ArtifactStore = {
      put: context.artifacts.put.bind(context.artifacts),
      get: context.artifacts.get.bind(context.artifacts),
      delete: context.artifacts.delete.bind(context.artifacts),
      signedDownload: async (key, seconds) => {
        signed.push({
          key,
          seconds
        });
        return "https://private.example/signed";
      }
    };
    const service = new HistoryService(context.store, adapter, {
      now: () => Date.parse(result.run.inputExpiresAt) - 20_000
    });
    await rejects(service.download("bob", project.projectId, result.run.runId, "report"), 404);
    expect(signed).to.deep.equal([]);
    expect(
      await service.download("alice", project.projectId, result.run.runId, "report")
    ).to.deep.equal({
      url: "https://private.example/signed",
      expiresIn: 60
    });
    expect(
      await service.download("alice", project.projectId, result.run.runId, "input")
    ).to.have.property("expiresIn", 20);
    expect(signed[0].key).to.match(
      /^owners\/alice\/projects\/[0-9a-f-]+\/runs\/[0-9a-f-]+\/[0-9a-f-]+\/report.json$/
    );
    await service.deleteProject("alice", project.projectId);
    await rejects(service.download("alice", project.projectId, result.run.runId, "report"), 404);
    expect(signed).to.have.length(2);
  });

  it("rejects tampered request shapes and returns no-cache errors without logging artifacts", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    for (const query of [{ ownerId: "bob" }, { limit: "0" }, { limit: "51" }, { limit: "1.5" }]) {
      expect((await context.api("alice", "GET", "/projects", undefined, query)).status).to.equal(
        400
      );
    }
    for (const body of [
      {
        ...request(),
        retainSource: "yes"
      },
      {
        ...request(),
        input: {
          template,
          ownerId: "bob"
        }
      },
      {
        ...request(),
        input: { template: "{}" }
      }
    ]) {
      expect(
        (await context.api("alice", "POST", `/projects/${project.projectId}/runs`, body)).status
      ).to.equal(400);
    }
    const response = await context.handler({
      httpMethod: "GET",
      path: "/projects"
    });
    expect(response.headers["cache-control"]).to.equal("no-store");
    expect(response.body).not.to.contain("OWNER#");
  });

  it("handles empty filtered pages, aborted saves and project cleanup beyond one batch", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const put = context.artifacts.put.bind(context.artifacts);
    context.artifacts.put = async () => {
      throw new Error("upload failed");
    };
    await context.api(
      "alice",
      "POST",
      `/projects/${project.projectId}/runs`,
      request("pending-key")
    );
    context.artifacts.put = put;
    context.advance(1);
    const result = await context.history.save("alice", project.projectId, request("completed-key"));
    const page = await context.history.listRuns("alice", project.projectId, 1);
    expect(page.items).to.deep.equal([]);
    expect(page.nextCursor).to.be.a("string");
    expect(
      (await context.history.listRuns("alice", project.projectId, 1, page.nextCursor)).items[0]
        .runId
    ).to.equal(result.run.runId);
    for (let i = 0; i < 25; i++) {
      context.advance(1);
      await context.history.save("alice", project.projectId, request(`batch-key-${i}`));
    }
    context.advance(120_001);
    expect(
      (await context.history.deleteProject("alice", project.projectId)).cleanupPending
    ).to.equal(true);
    expect((await context.history.cleanup("alice", 20)).cleanupPending).to.equal(false);
    expect(context.artifacts.objects.size).to.equal(0);
    await rejects(context.history.save("alice", project.projectId, request("completed-key")), 404);
  });

  it("does not delete a run recovered while cleanup is reading an expired pending manifest", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    const put = context.artifacts.put.bind(context.artifacts);
    context.artifacts.put = async () => {
      throw new Error("upload failed");
    };
    await context.api("alice", "POST", `/projects/${project.projectId}/runs`, request());
    context.artifacts.put = put;
    context.advance(120_001);
    const query = context.store.runs.query;
    let recovered: OpenSavedRun | undefined;
    context.store.runs.query = async <T extends StoredRecord>(
      ...args: Parameters<typeof query>
    ) => {
      const page = await query<T>(...args);
      if (!recovered) {
        recovered = await context.history.save("alice", project.projectId, request());
      }
      return page;
    };
    await context.history.cleanup("alice", 20);
    expect(
      (await context.history.open("alice", project.projectId, recovered!.run.runId)).report
    ).to.deep.equal(recovered!.report);
    expect(context.artifacts.objects.size).to.equal(3);
  });

  it("advances cleanup past pages of already-cleaned tombstones", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "p");
    for (let i = 0; i < 26; i++) {
      const result = await context.history.save(
        "alice",
        project.projectId,
        request(`cleaned-key-${i}`)
      );
      await context.history.deleteRun("alice", project.projectId, result.run.runId);
      context.advance(1);
    }
    const result = await context.history.save(
      "alice",
      project.projectId,
      request("last-to-delete")
    );
    expect(
      (await context.history.deleteProject("alice", project.projectId)).cleanupPending
    ).to.equal(true);
    expect(context.artifacts.objects.size).to.equal(3);
    const remove = context.artifacts.delete.bind(context.artifacts);
    context.artifacts.delete = async () => {
      throw new Error("Cleanup temporarily unavailable");
    };
    expect((await context.history.cleanup("alice", 20)).cleanupPending).to.equal(true);
    context.artifacts.delete = remove;
    expect((await context.history.cleanup("alice", 20)).cleanupPending).to.equal(false);
    expect(context.artifacts.objects.size).to.equal(0);
    await rejects(context.history.open("alice", project.projectId, result.run.runId), 404);
  });

  it("enforces owner-wide run and lifetime idempotency quotas across projects", async () => {
    const context = setup({
      quotas: {
        runsPerUser: 1,
        saveKeysPerUser: 1
      }
    });
    const project = await context.history.createProject("alice", "p");
    const secondProject = await context.history.createProject("alice", "q");
    const result = await context.history.save("alice", project.projectId, request());
    await rejects(
      context.history.save("alice", secondProject.projectId, request("second-project")),
      409
    );
    await context.history.deleteRun("alice", project.projectId, result.run.runId);
    await context.history.deleteRun("alice", project.projectId, result.run.runId);
    await rejects(
      context.history.save("alice", secondProject.projectId, request("new-lifetime-key")),
      409
    );
    expect(
      await context.store.projects.get({
        pk: "OWNER#alice",
        sk: "OWNER"
      })
    ).to.include({
      runCount: 0,
      saveKeyCount: 1
    });
  });

  it("serves the same workflow through Express with explicit local identity and CORS", async () => {
    const context = setup();
    const server = createApiApp({
      history: context.history,
      localOwner: "local-user",
      writeLog: () => {}
    }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = createHistoryClient(base, fetch);
      const project = await client.create("Local workflow");
      const result = await client.save(project.projectId, request());
      expect((await client.open(project.projectId, result.run.runId)).report).to.deep.equal(
        result.report
      );
      const fixIds = result.report.templateFixes!.filter(fix => fix.applicability === "applicable").map(fix => fix.id);
      const child = await client.apply(project.projectId, result.run.runId, { fixIds, idempotencyKey: "express-child" });
      const reanalyzed = await client.reanalyze(project.projectId, child.run.runId, { idempotencyKey: "express-reanalysis" });
      expect(reanalyzed.run.provenance!.parentRun.runId).to.equal(child.run.runId);
      expect(reanalyzed.run.analyzerVersion).to.equal(result.run.analyzerVersion);
      expect((await client.rename(project.projectId, "renamed")).name).to.equal("renamed");
      const preflight = await fetch(`${base}/projects/${project.projectId}`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "DELETE"
        }
      });
      expect(preflight.headers.get("access-control-allow-methods"))
        .to.contain("DELETE")
        .and.contain("PATCH");
      await client.deleteProject(project.projectId);
      expect((await client.projects()).items).to.deep.equal([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
