import { randomUUID } from "node:crypto";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AwsHistoryStore, S3ArtifactStore } from "../src/historyAws";
import { HistoryService } from "../src/historyService";
import type { OpenSavedRun, SavedProject } from "@infralens/shared";

// Never included by the ordinary *.test.ts glob. Explicit resources + opt-in are mandatory.
describe("disposable AWS DynamoDB/S3 persistence", function () {
  const enabled = process.env.INFRALENS_DISPOSABLE_AWS === "true";
  const projects = process.env.INFRALENS_TEST_PROJECTS_TABLE;
  const runs = process.env.INFRALENS_TEST_RUNS_TABLE;
  const bucket = process.env.INFRALENS_TEST_ARTIFACT_BUCKET;
  const owner = `test-${randomUUID()}`;
  const otherOwner = `test-${randomUUID()}`;
  let service: HistoryService;
  let project: SavedProject;
  let otherProject: SavedProject;
  let saved: OpenSavedRun;
  const input = {
    template: JSON.stringify({ Resources: { Bucket: { Type: "AWS::S3::Bucket" } } })
  };
  before(function () {
    if (!enabled) {
      return this.skip();
    }
    if (!projects || !runs || !bucket) {
      throw new Error("Explicit disposable test table and bucket names are required.");
    }
    service = new HistoryService(
      new AwsHistoryStore({
        projects,
        runs
      }),
      new S3ArtifactStore(bucket)
    );
  });

  it("uses real transactions for project CRUD and duplicate saves", async () => {
    project = await service.createProject(owner, "AWS integration");
    otherProject = await service.createProject(otherOwner, "Other owner");
    expect((await service.renameProject(owner, project.projectId, "Renamed")).name).to.equal(
      "Renamed"
    );
    saved = await service.save(owner, project.projectId, {
      input,
      idempotencyKey: "aws-save-key"
    });
    const duplicate = await service.save(owner, project.projectId, {
      input,
      idempotencyKey: "aws-save-key"
    });
    expect(duplicate.run.runId).to.equal(saved.run.runId);
    expect((await service.open(owner, project.projectId, saved.run.runId)).report).to.deep.equal(
      saved.report
    );
  });

  it("uses opaque pagination and owner isolation with the real tables", async () => {
    await service.save(owner, project.projectId, {
      input,
      idempotencyKey: "aws-save-key-two"
    });
    const page = await service.listRuns(owner, project.projectId, 1);
    expect(page.items).to.have.length(1);
    expect(page.nextCursor).to.be.a("string");
    expect(
      (await service.listRuns(owner, project.projectId, 1, page.nextCursor)).items
    ).to.have.length(1);
    try {
      await service.open(otherOwner, project.projectId, saved.run.runId);
      expect.fail("Cross-owner access succeeded");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).to.equal(404);
    }
    try {
      await service.listRuns(otherOwner, otherProject.projectId, 1, page.nextCursor);
      expect.fail("Cross-owner cursor succeeded");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).to.equal(400);
    }
  });

  it("issues a short-lived working S3 download only after authorization", async () => {
    const download = await service.download(owner, project.projectId, saved.run.runId, "report");
    expect(download).to.have.property("expiresIn", 60);
    const response = await fetch((download as { url: string }).url);
    expect(response.status).to.equal(200);
    expect(await response.json()).to.deep.equal(saved.report);
    const unsigned = new URL((download as { url: string }).url);
    unsigned.search = "";
    expect((await fetch(unsigned)).status).to.equal(403);
    await service.deleteRun(owner, project.projectId, saved.run.runId);
    try {
      await service.download(owner, project.projectId, saved.run.runId, "report");
      expect.fail("Deleted run accessible");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).to.equal(404);
    }
  });
  after(async function () {
    if (!enabled || !service || !projects || !runs) {
      return;
    }
    // Clean only this suite's random owner namespaces, including metadata tombstones.
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    for (const [user, projectToClean] of [
      [owner, project],
      [otherOwner, otherProject]
    ] as const) {
      if (projectToClean) {
        // No operation is still running; advance recovery time for any failed test's pending manifest.
        const cleanup = new HistoryService(
          new AwsHistoryStore({
            projects,
            runs
          }),
          new S3ArtifactStore(bucket!),
          { now: () => Date.now() + 121000 }
        );
        const result = await cleanup.deleteProject(user, projectToClean.projectId);
        if (result.cleanupPending) {
          throw new Error(
            "Disposable artifact cleanup remains pending; retry cleanup before removing metadata."
          );
        }
      }
      const partitions = [
        [projects, `OWNER#${user}`],
        ...(projectToClean ? [[runs, `OWNER#${user}#PROJECT#${projectToClean.projectId}`]] : [])
      ];
      for (const [table, pk] of partitions) {
        let afterKey: Record<string, unknown> | undefined;
        do {
          const page = await client.send(
            new QueryCommand({
              TableName: table,
              KeyConditionExpression: "pk = :pk",
              ExpressionAttributeValues: { ":pk": pk },
              ConsistentRead: true,
              ExclusiveStartKey: afterKey
            })
          );
          for (const item of page.Items ?? []) {
            await client.send(
              new DeleteCommand({
                TableName: table,
                Key: {
                  pk: item.pk,
                  sk: item.sk
                }
              })
            );
          }
          afterKey = page.LastEvaluatedKey;
        } while (afterKey);
      }
    }
  });
});

describe("optional disposable hosted Cognito isolation", () => {
  it("checks two independently authenticated users through API Gateway", async function () {
    const base = process.env.INFRALENS_TEST_API_URL?.replace(/\/+$/, "");
    const firstUserToken = process.env.INFRALENS_TEST_USER_A_TOKEN;
    const secondUserToken = process.env.INFRALENS_TEST_USER_B_TOKEN;
    if (
      process.env.INFRALENS_DISPOSABLE_AWS !== "true" ||
      !base ||
      !firstUserToken ||
      !secondUserToken
    ) {
      return this.skip();
    }
    if (firstUserToken === secondUserToken || !base.startsWith("https://")) {
      throw new Error(
        "Two distinct test user tokens and an HTTPS disposable API URL are required."
      );
    }
    const call = (token: string, path: string, method = "GET", body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    const created = await call(firstUserToken, "/projects", "POST", {
      name: `Isolation ${randomUUID()}`
    });
    expect(created.status).to.equal(201);
    const project = (await created.json()) as SavedProject;
    try {
      const savedResponse = await call(
        firstUserToken,
        `/projects/${project.projectId}/runs`,
        "POST",
        {
          input: { template: '{"Resources":{"Bucket":{"Type":"AWS::S3::Bucket"}}}' },
          idempotencyKey: randomUUID()
        }
      );
      expect(savedResponse.status).to.equal(201);
      const saved = (await savedResponse.json()) as OpenSavedRun;
      const path = `/projects/${project.projectId}/runs/${saved.run.runId}`;
      expect((await call(firstUserToken, path)).status).to.equal(200);
      for (const [method, route] of [
        ["GET", path],
        ["DELETE", path],
        ["GET", `${path}/artifacts/report`],
        ["GET", `/projects/${project.projectId}/runs`],
        ["DELETE", `/projects/${project.projectId}`]
      ]) {
        expect((await call(secondUserToken, route, method)).status).to.equal(404);
      }
    } finally {
      expect(
        (await call(firstUserToken, `/projects/${project.projectId}`, "DELETE")).status
      ).to.equal(200);
    }
  });
});
