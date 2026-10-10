import { randomUUID } from "node:crypto";
import { expect } from "chai";
import type { OpenSavedRun, SavedProject } from "@infralens/shared";
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
