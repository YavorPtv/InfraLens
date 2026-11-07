import { randomUUID } from "node:crypto";
import { expect } from "chai";
import { exportDiffReportToMarkdown, type DiffReport, type OpenSavedRun, type SavedProject } from "@infralens/shared";
import { hostedTestRequest, readHostedTestConfiguration, requireTestDataWrites } from "./hostedTestHelpers";
import { TestUserAuthentication } from "./testUserAuthentication";
import type { TestUser } from "./testUserCredentials";
import type { SavedRun, SubmittedAnalysis } from "@infralens/shared";

// Separate from direct SDK tests: this suite uses Cognito-authenticated HTTP and temporary test data.
describe("hosted test Cognito isolation", function () {
  this.timeout(120_000);
  let authentication: TestUserAuthentication | undefined;
  after(() => authentication?.clear());
  it("saves and restores a report while denying another user's access", async () => {
    const configuration = readHostedTestConfiguration();
    requireTestDataWrites(configuration);
    authentication = new TestUserAuthentication(configuration);
    await authentication.assertDistinctUsers();
    const call = async (user: TestUser, path: string, method = "GET", body?: unknown) => {
      const token = await authentication!.accessToken(user);
      return hostedTestRequest(configuration, path, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    };
    const created = await call("A", "projects", "POST", { name: `Isolation ${randomUUID()}` });
    expect(created.status).to.equal(201);
    const project = await created.json() as SavedProject;
    try {
      const savedResponse = await call("A", `projects/${project.projectId}/runs`, "POST", {
        input: { template: '{"Resources":{"Bucket":{"Type":"AWS::S3::Bucket"}}}' },
        idempotencyKey: randomUUID()
      });
      expect(savedResponse.status).to.equal(201);
      const saved = await savedResponse.json() as OpenSavedRun;
      const path = `projects/${project.projectId}/runs/${saved.run.runId}`;
      const restored = await call("A", path);
      expect(restored.status).to.equal(200);
      expect((await restored.json() as OpenSavedRun).report).to.deep.equal(saved.report);
      const childBody = { idempotencyKey: randomUUID(), fixIds: saved.report.templateFixes!.filter(fix => fix.applicability === "applicable").map(fix => fix.id) };
      expect(childBody.fixIds.length).to.be.greaterThan(0);
      expect((await call("B", `${path}/apply`, "POST", childBody)).status).to.equal(404);
      const applied = await call("A", `${path}/apply`, "POST", childBody);
      expect(applied.status).to.equal(201);
      const child = await applied.json() as OpenSavedRun;
      expect(child.run.provenance!.parentRun.runId).to.equal(saved.run.runId);
      expect(child.run.analyzerVersion).to.be.a("string").and.not.equal("unknown");
      const retried = await call("A", `${path}/apply`, "POST", childBody);
      expect(retried.status).to.equal(201);
      expect((await retried.json() as OpenSavedRun).run.runId).to.equal(child.run.runId);
      const childPath = `projects/${project.projectId}/runs/${child.run.runId}`;
      const reference = (run: OpenSavedRun["run"]) => ({ projectId: run.projectId, runId: run.runId });
      const compared = await call("A", "projects/compare", "POST", { oldRun: reference(saved.run), newRun: reference(child.run) });
      expect(compared.status).to.equal(200);
      const diff = await compared.json() as DiffReport;
      expect(diff.findings.resolved.length).to.be.greaterThan(0);
      expect(exportDiffReportToMarkdown(diff)).to.include("does not replay historical saved output");
      const reanalysisBody = { idempotencyKey: randomUUID() };
      expect((await call("B", `${childPath}/reanalyze`, "POST", reanalysisBody)).status).to.equal(404);
      const reanalyzed = await call("A", `${childPath}/reanalyze`, "POST", reanalysisBody);
      expect(reanalyzed.status).to.equal(201);
      expect((await reanalyzed.json() as OpenSavedRun).run.provenance!.kind).to.equal("reanalysis");
      for (const [method, route] of [
        ["GET", path], ["DELETE", path], ["GET", `${path}/artifacts/report`],
        ["GET", `projects/${project.projectId}/runs`], ["DELETE", `projects/${project.projectId}`]
      ]) {
        expect((await call("B", route, method)).status).to.equal(404);
      }
    } finally {
      const response = await call("A", `projects/${project.projectId}`, "DELETE");
      expect(response.status, "Delete only the project created by this test").to.equal(200);
      const cleanup = await response.json() as { cleanupPending: boolean };
      if (cleanup.cleanupPending) {
        throw new Error(`Test project ${project.projectId} has pending cleanup; preserve its recovery metadata.`);
      }
    }
  });

  it("submits persistent jobs, polls from a fresh request, isolates users and links explicit retries", async function () {
    this.timeout(360_000);
    const configuration = readHostedTestConfiguration();
    requireTestDataWrites(configuration);
    authentication?.clear();
    authentication = new TestUserAuthentication(configuration);
    await authentication.assertDistinctUsers();
    const call = async (user: TestUser, path: string, method = "GET", body?: unknown) => {
      const token = await authentication!.accessToken(user);
      return hostedTestRequest(configuration, path, { method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const created = await call("A", "projects", "POST", { name: `Async acceptance ${randomUUID()}` });
    expect(created.status).to.equal(201);
    const project = await created.json() as SavedProject;
    const base = `projects/${project.projectId}`;
    const waitForTerminal = async (runId: string): Promise<SavedRun> => {
      const deadline = Date.now() + 90_000;
      let delay = 2000;
      while (Date.now() < deadline) {
        const response = await call("A", `${base}/runs/${runId}/status`);
        expect(response.status).to.equal(200);
        const run = await response.json() as SavedRun;
        if (run.job?.status === "SUCCEEDED" || run.job?.status === "FAILED") return run;
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(10_000, delay * 2);
      }
      throw new Error(`Job ${runId} did not reach a terminal state within the acceptance window.`);
    };
    try {
      const input = { template: '{"Resources":{"Bucket":{"Type":"AWS::S3::Bucket"}}}',
        sourceFiles: { "fixture.ts": "// async acceptance source" } };
      const body = { input, retainSource: true, idempotencyKey: randomUUID() };
      expect((await call("B", `${base}/runs/async`, "POST", body)).status).to.equal(404);
      const submittedResponse = await call("A", `${base}/runs/async`, "POST", body);
      expect(submittedResponse.status).to.equal(202);
      const submitted = await submittedResponse.json() as SubmittedAnalysis;
      const path = `${base}/runs/${submitted.run.runId}`;
      expect((await call("B", `${path}/status`)).status).to.equal(404);
      expect((await call("B", `${path}/retry`, "POST", { ...body, idempotencyKey: randomUUID() })).status).to.equal(404);
      expect((await call("B", `${path}/artifacts/report`)).status).to.equal(404);
      const duplicate = await call("A", `${base}/runs/async`, "POST", body);
      expect(duplicate.status).to.equal(202);
      expect((await duplicate.json() as SubmittedAnalysis).run.runId).to.equal(submitted.run.runId);
      expect((await waitForTerminal(submitted.run.runId)).job!.status).to.equal("SUCCEEDED");
      const restored = await call("A", path);
      expect(restored.status).to.equal(200);
      const opened = await restored.json() as OpenSavedRun;
      expect(opened.input).to.deep.equal(input);
      expect(opened.run.analyzerVersion).not.to.equal("unknown");
      const badResponse = await call("A", `${base}/runs/async`, "POST", {
        input: { template: "invalid: [" }, idempotencyKey: randomUUID()
      });
      expect(badResponse.status).to.equal(202);
      const bad = await badResponse.json() as SubmittedAnalysis;
      const failure = await waitForTerminal(bad.run.runId);
      expect(failure.job).to.include({ status: "FAILED", failure: "INVALID_INPUT" });
      const retriedResponse = await call("A", `${base}/runs/${bad.run.runId}/retry`, "POST", {
        input, idempotencyKey: randomUUID()
      });
      expect(retriedResponse.status).to.equal(202);
      const retried = await retriedResponse.json() as SubmittedAnalysis;
      expect(retried.run.provenance).to.include({ kind: "retry", inputMode: "reuploaded" });
      expect(retried.run.provenance!.parentRun.runId).to.equal(bad.run.runId);
      expect((await waitForTerminal(retried.run.runId)).job!.status).to.equal("SUCCEEDED");
      expect((await waitForTerminal(bad.run.runId)).job).to.deep.equal(failure.job);
      expect((await (await call("A", path)).json() as OpenSavedRun).report).to.deep.equal(opened.report);
    } finally {
      // Writers' hard lifetimes/leases apply to real storage too; never discard recovery manifests.
      const deadline = Date.now() + 150_000;
      let pending = true;
      while (pending && Date.now() < deadline) {
        const deleted = await call("A", base, "DELETE");
        expect(deleted.status).to.equal(200);
        pending = (await deleted.json() as { cleanupPending: boolean }).cleanupPending;
        if (pending) await new Promise(resolve => setTimeout(resolve, 5000));
      }
      expect(pending, `Only test project ${project.projectId} cleanup must finish; preserve recovery metadata if pending`).to.equal(false);
    }
  });
});
