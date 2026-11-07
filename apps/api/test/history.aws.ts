import { randomUUID } from "node:crypto";
import { expect } from "chai";
import { afterEach, before, beforeEach, describe, it } from "mocha";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AwsHistoryStore, S3ArtifactStore } from "../src/historyAws";
import { HistoryService } from "../src/historyService";
import { jobLeaseMs, type AnalysisMessage } from "../src/analysisQueue";
import { analyzeValidatedBody, ApiRequestError } from "../src/analyzeRequest";
import { defaultApiRequestLimits } from "../src/requestLimits";
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

  it("persists linked Apply/reanalysis children using real parent transactions and retained artifacts", async () => {
    const { project, saved } = fixture();
    const fixIds = saved.report.templateFixes!.filter(fix => fix.applicability === "applicable").map(fix => fix.id);
    expect(fixIds.length).to.be.greaterThan(0);
    const request = { fixIds, idempotencyKey: "aws-apply-child" };
    const child = await service.derive(owner, project.projectId, saved.run.runId, "apply", request);
    expect(child.run.provenance!.parentRun.runId).to.equal(saved.run.runId);
    expect((await service.derive(owner, project.projectId, saved.run.runId, "apply", request)).run.runId).to.equal(child.run.runId);
    const fresh = new HistoryService(new AwsHistoryStore({ projects, runs }, client), artifacts);
    expect((await fresh.open(owner, project.projectId, child.run.runId)).report).to.deep.equal(child.report);
    expect((await fresh.open(owner, project.projectId, saved.run.runId)).report).to.deep.equal(saved.report);
    const diff = await fresh.compare(owner, saved.run, child.run);
    expect(diff.findings.resolved.length).to.be.greaterThan(0);
    expect(diff.savedComparison!.current.analyzerVersion).to.equal(child.run.analyzerVersion);
    const reanalyzed = await fresh.derive(owner, project.projectId, child.run.runId, "reanalysis", { idempotencyKey: "aws-reanalysis-child" });
    expect(reanalyzed.run.provenance!.kind).to.equal("reanalysis");
    expect(reanalyzed.report.analyzerVersion).to.equal(child.report.analyzerVersion);
    try {
      await fresh.derive(otherOwner, project.projectId, child.run.runId, "reanalysis", { idempotencyKey: "aws-foreign-child" });
      expect.fail("Cross-owner derivation succeeded");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).to.equal(404);
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

  it("recovers missed sends and a crashed claim through the deployed scheduler and SQS worker", async function () {
    this.timeout(360_000);
    const { project } = fixture();
    const store = new AwsHistoryStore({ projects, runs }, client);
    let failedSends = 0;
    const failedSender = new HistoryService(store, artifacts, { queue: {
      send: async () => { failedSends++; throw new Error("Simulated dispatch outage"); }
    } });
    const missed = await failedSender.submit(owner, project.projectId, { input, idempotencyKey: "aws-missed-send" });
    const poison = await failedSender.submit(owner, project.projectId, {
      input: { template: "invalid: [" }, idempotencyKey: "aws-poison-input"
    });
    expect(failedSends).to.equal(2);

    const delivered: AnalysisMessage[] = [];
    let clockOffset = 0;
    const crashingWorker = new HistoryService(store, artifacts, {
      queue: { send: async message => { delivered.push(message); } },
      now: () => Date.now() + clockOffset,
      analyze: async () => { throw new Error("Simulated worker crash after claim"); }
    });
    const crashed = await crashingWorker.submit(owner, project.projectId, { input, idempotencyKey: "aws-crashed-claim" });
    expect(delivered).to.have.length(1);
    // Age just this fixture's claim so the real scheduler can recover it on its next pass.
    clockOffset = -jobLeaseMs - 5000;
    const failure = await crashingWorker.processJob(delivered[0]).catch(error => error);
    expect(failure).to.be.instanceOf(Error).with.property("message", "Simulated worker crash after claim");

    // The staging writer lease can expire just after a scheduler tick. Allow the full lease,
    // another two-minute schedule interval, and time for SQS delivery and worker startup.
    const deadline = Date.now() + jobLeaseMs + 160_000;
    let complete = false;
    while (Date.now() < deadline) {
      const statuses = await Promise.all([missed, poison, crashed].map(({ run }) => service.status(owner, project.projectId, run.runId)));
      if (statuses.every(run => run.job?.status === "SUCCEEDED" || run.job?.status === "FAILED")) {
        expect(statuses.map(run => run.job?.status)).to.deep.equal(["SUCCEEDED", "FAILED", "SUCCEEDED"]);
        expect(statuses[1].job?.failure).to.equal("INVALID_INPUT");
        expect(statuses[2].job?.attempts).to.equal(2);
        complete = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    expect(complete, "scheduled recovery and the deployed worker must reach terminal states").to.equal(true);
    const recovered = await service.open(owner, project.projectId, crashed.run.runId);
    // Replaying the same delivery against real persisted state must leave the winning report alone.
    await service.processJob(delivered[0]);
    const reopened = await service.open(owner, project.projectId, crashed.run.runId);
    expect(reopened.run.job?.attempts).to.equal(2);
    expect(reopened.report).to.deep.equal(recovered.report);
  });

  it("keeps a deleted project inaccessible when a claimed worker tries to publish", async () => {
    const { project } = fixture();
    const messages: AnalysisMessage[] = [];
    let announceClaim: () => void;
    let releaseWorker: () => void;
    const claimed = new Promise<void>(resolve => { announceClaim = resolve; });
    const resume = new Promise<void>(resolve => { releaseWorker = resolve; });
    const worker = new HistoryService(new AwsHistoryStore({ projects, runs }, client), artifacts, {
      queue: { send: async message => { messages.push(message); } },
      analyze: async value => {
        announceClaim();
        await resume;
        return analyzeValidatedBody(JSON.stringify(value), undefined, defaultApiRequestLimits);
      }
    });
    const submitted = await worker.submit(owner, project.projectId, { input, idempotencyKey: "aws-delete-active" });
    expect(messages).to.have.length(1);
    const attempt = worker.processJob(messages[0]).then(() => undefined, error => error);
    try {
      await Promise.race([claimed, attempt.then(() => { throw new Error("Worker ended before its claim was observed"); })]);
      expect((await service.status(owner, project.projectId, submitted.run.runId)).job?.status).to.equal("RUNNING");
      const deletion = await service.deleteProject(owner, project.projectId);
      expect(deletion.cleanupPending).to.equal(true);
    } finally {
      releaseWorker!();
      await attempt;
    }
    expect(await attempt).to.be.instanceOf(ApiRequestError).with.property("statusCode", 404);
    for (const lookup of [service.status.bind(service), service.open.bind(service)]) {
      const failure = await lookup(owner, project.projectId, submitted.run.runId).catch(error => error);
      expect(failure).to.be.instanceOf(ApiRequestError).with.property("statusCode", 404);
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
