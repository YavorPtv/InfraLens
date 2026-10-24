import { randomUUID } from "node:crypto";
import { expect } from "chai";
import { exportDiffReportToMarkdown, type DiffReport, type OpenSavedRun, type SavedProject } from "@infralens/shared";
import { hostedTestRequest, readHostedTestConfiguration, requireTestDataWrites } from "./hostedTestHelpers";
import { TestUserAuthentication } from "./testUserAuthentication";
import type { TestUser } from "./testUserCredentials";

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
});
