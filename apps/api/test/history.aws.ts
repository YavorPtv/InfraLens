import { randomUUID } from "node:crypto";
import { expect } from "chai";
import { afterEach, before, beforeEach, describe, it } from "mocha";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AwsHistoryStore, S3ArtifactStore } from "../src/historyAws";
import { HistoryService } from "../src/historyService";
import type { OpenSavedRun, SavedProject } from "@infralens/shared";
import { readHostedTestConfiguration, requireTestDataWrites, type HostedTestConfiguration } from "./hostedTestHelpers";

// Never included by ordinary *.test.ts discovery. Use the guarded storage workflow.
describe("persistent test stack AWS DynamoDB/S3 persistence", function () {
  let configuration: HostedTestConfiguration;
  let projects: string;
  let runs: string;
  let bucket: string;
  let owner: string;
  let otherOwner: string;
  let client: DynamoDBDocumentClient;
  let artifacts: S3ArtifactStore;
  let service: HistoryService;
  let project: SavedProject | undefined;
  let otherProject: SavedProject | undefined;
  let saved: OpenSavedRun | undefined;
  const input = {
    template: JSON.stringify({ Resources: { Bucket: { Type: "AWS::S3::Bucket" } } })
  };
  function fixture() {
    if (!project || !otherProject || !saved) throw new Error("AWS test fixture setup did not complete.");
    return { project, otherProject, saved };
  }
  before(function () {
    configuration = readHostedTestConfiguration();
    requireTestDataWrites(configuration);
    if (process.env.AWS_PROFILE !== configuration.profile || process.env.AWS_REGION !== configuration.region ||
        process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SESSION_TOKEN) {
      throw new Error("Storage tests require the guarded workflow's pinned AWS profile and region.");
    }
    projects = configuration.projectsTable;
    runs = configuration.runsTable;
    bucket = configuration.artifactBucket;
    client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: configuration.region }), {
      marshallOptions: { removeUndefinedValues: true }
    });
    artifacts = new S3ArtifactStore(bucket, new S3Client({ region: configuration.region }));
  });

  beforeEach(async function () {
    owner = `test-${randomUUID()}`;
    otherOwner = `test-${randomUUID()}`;
    // Fresh fixtures let each test run independently, including with Mocha --grep.
    project = undefined;
    otherProject = undefined;
    saved = undefined;
    service = new HistoryService(new AwsHistoryStore({ projects, runs }, client), artifacts);
    project = await service.createProject(owner, "AWS integration");
    otherProject = await service.createProject(otherOwner, "Other owner");
    saved = await service.save(owner, project.projectId, { input, idempotencyKey: "aws-save-key" });
  });

  it("uses real transactions for project CRUD and duplicate saves", async () => {
    const { project } = fixture();
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
    const { project, otherProject, saved } = fixture();
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
    const { project, saved } = fixture();
    const download = await service.download(owner, project.projectId, saved.run.runId, "report");
    // Assert the duration alone so a failure does not print a signed URL or temporary credentials.
    expect((download as { expiresIn: number }).expiresIn).to.equal(60);
    const response = await fetch((download as { url: string }).url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    expect(response.status).to.equal(200);
    expect(await response.json()).to.deep.equal(saved.report);
    const unsigned = new URL((download as { url: string }).url);
    unsigned.search = "";
    expect((await fetch(unsigned, { redirect: "error", signal: AbortSignal.timeout(10_000) })).status).to.equal(403);
    await service.deleteRun(owner, project.projectId, saved.run.runId);
    try {
      await service.download(owner, project.projectId, saved.run.runId, "report");
      expect.fail("Deleted run accessible");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).to.equal(404);
    }
  });
  afterEach(async function () {
    if (!service || !projects || !runs) {
      return;
    }
    // Clean only this suite's random owner namespaces, including metadata tombstones.
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
          }, client),
          artifacts,
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
