import { randomUUID } from "node:crypto";
import { expect } from "chai";
import type { OpenSavedRun, SavedProject } from "@infralens/shared";
import { distinctTestUsers, hostedTestRequest, readHostedTestConfiguration, requireTestDataWrites } from "./hostedTestHelpers";

// Separate from direct SDK tests: this suite uses Cognito-authenticated HTTP and temporary test data.
describe("hosted test Cognito isolation", function () {
  this.timeout(60_000);
  it("saves and restores a report while denying another user's access", async () => {
    const configuration = readHostedTestConfiguration();
    requireTestDataWrites(configuration);
    const firstUserToken = process.env.INFRALENS_TEST_USER_A_TOKEN;
    const secondUserToken = process.env.INFRALENS_TEST_USER_B_TOKEN;
    distinctTestUsers(firstUserToken, secondUserToken, configuration);
    const call = (token: string, path: string, method = "GET", body?: unknown) =>
      hostedTestRequest(configuration, path, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    const created = await call(firstUserToken!, "projects", "POST", { name: `Isolation ${randomUUID()}` });
    expect(created.status).to.equal(201);
    const project = await created.json() as SavedProject;
    try {
      const savedResponse = await call(firstUserToken!, `projects/${project.projectId}/runs`, "POST", {
        input: { template: '{"Resources":{"Bucket":{"Type":"AWS::S3::Bucket"}}}' },
        idempotencyKey: randomUUID()
      });
      expect(savedResponse.status).to.equal(201);
      const saved = await savedResponse.json() as OpenSavedRun;
      const path = `projects/${project.projectId}/runs/${saved.run.runId}`;
      const restored = await call(firstUserToken!, path);
      expect(restored.status).to.equal(200);
      expect((await restored.json() as OpenSavedRun).report).to.deep.equal(saved.report);
      for (const [method, route] of [
        ["GET", path], ["DELETE", path], ["GET", `${path}/artifacts/report`],
        ["GET", `projects/${project.projectId}/runs`], ["DELETE", `projects/${project.projectId}`]
      ]) {
        expect((await call(secondUserToken!, route, method)).status).to.equal(404);
      }
    } finally {
      const response = await call(firstUserToken!, `projects/${project.projectId}`, "DELETE");
      expect(response.status, "Delete only the project created by this test").to.equal(200);
      const cleanup = await response.json() as { cleanupPending: boolean };
      if (cleanup.cleanupPending) {
        throw new Error(`Test project ${project.projectId} has pending cleanup; preserve its recovery metadata.`);
      }
    }
  });
});
