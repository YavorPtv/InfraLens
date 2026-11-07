import { expect } from "chai";
import { describe, it } from "mocha";
import type { SaveAnalysisRequest } from "@infralens/shared";
import { HistoryService, type HistoryServiceOptions } from "../src/historyService";
import { MemoryArtifactStore, MemoryHistoryStore, type OwnerRecord, type RunRecord, write } from "../src/historyStore";
import { createAnalyzeLambdaHandler } from "../src/lambda";
import { analyzeValidatedBody, ApiRequestError } from "../src/analyzeRequest";
import { createAnalysisWorker } from "../src/analysisWorker";
import { jobLeaseMs, jobRecoveryMs, jobDeadlineMs, parseAnalysisMessage, type AnalysisMessage } from "../src/analysisQueue";
import { analysisPollDelay, createHistoryClient } from "../../web/src/api/historyClient";
import { defaultApiRequestLimits } from "../src/requestLimits";

const analyze = (body: string) => analyzeValidatedBody(body, undefined, defaultApiRequestLimits);

const input = { template: JSON.stringify({ Resources: { Bucket: { Type: "AWS::S3::Bucket" } } }),
  sourceFiles: { "handler.ts": "// private source for processing" }, sourceFileMappings: {}, sourceFileExclusions: [] };
const request = (key = "async-save-key"): SaveAnalysisRequest => ({ input, idempotencyKey: key });

class ControlledArtifacts extends MemoryArtifactStore {
  failInput = false;
  failOutput = false;
  failDelete = false;
  beforeInputPut?: () => Promise<void>;
  async put(key: string, body: string): Promise<void> {
    if ((this.failInput && key.endsWith("job-input.json")) || (this.failOutput && key.endsWith("report.json"))) throw new Error("S3 unavailable");
    if (key.endsWith("job-input.json")) await this.beforeInputPut?.();
    await super.put(key, body);
  }
  async delete(key: string): Promise<void> {
    if (this.failDelete) throw new Error("Delete unavailable");
    await super.delete(key);
  }
}

function setup(options: HistoryServiceOptions = {}) {
  let time = Date.parse("2026-10-26T12:00:00Z");
  const store = new MemoryHistoryStore();
  const artifacts = new ControlledArtifacts();
  const messages: AnalysisMessage[] = [];
  const queue = { fail: false, onSend: undefined as undefined | ((message: AnalysisMessage) => Promise<void>),
    send: async (message: AnalysisMessage) => {
      if (queue.fail) throw new Error("SQS unavailable");
      messages.push(message);
      await queue.onSend?.(message);
    } };
  const history = new HistoryService(store, artifacts, { ...options, queue, now: () => time });
  const handler = createAnalyzeLambdaHandler({ history });
  const fetcher: typeof fetch = async (url, init) => {
    const result = await handler({ path: new URL(String(url)).pathname, httpMethod: init?.method ?? "GET",
      body: init?.body as string | undefined, requestContext: { authorizer: { claims: { sub: "alice" } } } });
    return new Response(result.body, { status: result.statusCode });
  };
  const client = () => createHistoryClient("https://offline.example", fetcher);
  const record = async (projectId: string, runId: string) => (await store.runs.get<RunRecord>({
    pk: `OWNER#alice#PROJECT#${projectId}`, sk: `RUN#${runId}` }))!;
  const owner = async () => (await store.projects.get<OwnerRecord>({ pk: "OWNER#alice", sk: "OWNER" }))!;
  return { store, artifacts, messages, queue, history, handler, client, record, owner, advance: (ms: number) => { time += ms; } };
}

async function rejects(promise: Promise<unknown>, status?: number) {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure, "expected failure").to.be.instanceOf(Error);
  if (status) expect((failure as ApiRequestError).statusCode).to.equal(status);
}

describe("asynchronous saved analysis controlled workload (offline)", () => {
  it("requires trusted identity and rejects report/owner fields on every new submission route", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "transport");
    const path = `/projects/${project.projectId}/runs/async`;
    expect((await context.handler({ path, httpMethod: "POST", body: JSON.stringify(request()) })).statusCode).to.equal(401);
    for (const extra of [{ ownerId: "bob" }, { report: { score: 100 } }]) {
      expect((await context.handler({ path, httpMethod: "POST", body: JSON.stringify({ ...request(), ...extra }),
        requestContext: { authorizer: { claims: { sub: "alice" } } } })).statusCode).to.equal(400);
    }
    const saved = await context.history.submit("alice", project.projectId, request());
    expect((await context.handler({ path: `/projects/${project.projectId}/runs/${saved.run.runId}/status`, httpMethod: "GET" })).statusCode).to.equal(401);
    expect((await context.handler({ path: `/projects/${project.projectId}/runs/${saved.run.runId}/retry`, httpMethod: "POST",
      body: JSON.stringify(request("retry-unauthorized")), requestContext: { authorizer: { claims: { sub: "bob" } } } })).statusCode).to.equal(404);
  });

  it("returns 202 before analysis, supports fresh-session status/history, then opens server-generated immutable output", async () => {
    let analyses = 0;
    const context = setup({ analyze: async value => { analyses++; return analyze(JSON.stringify(value)); } });
    const project = await context.client().create("async workflow");
    const response = await context.handler({ path: `/projects/${project.projectId}/runs/async`, httpMethod: "POST",
      body: JSON.stringify(request()), requestContext: { authorizer: { claims: { sub: "alice" } } } });
    expect(response.statusCode).to.equal(202);
    const { run } = JSON.parse(response.body);
    expect(run.job.status).to.equal("QUEUED");
    expect(analyses).to.equal(0);
    expect((await context.client().status(project.projectId, run.runId)).job!.status).to.equal("QUEUED");
    expect((await context.client().runs(project.projectId)).items.map(item => item.runId)).to.include(run.runId);
    await rejects(context.history.open("alice", project.projectId, run.runId), 404);
    expect(JSON.stringify(context.messages)).not.to.include("private source");
    expect(context.messages[0]).to.have.all.keys("ownerId", "projectId", "runId", "inputKey", "inputHash");
    expect(run.job).to.have.all.keys("status", "attempts", "updatedAt");
    await context.history.processJob(context.messages[0]);
    const opened = await context.client().open(project.projectId, run.runId);
    expect(opened.run.job!.status).to.equal("SUCCEEDED");
    expect(opened.report.analyzerVersion).to.equal("0.2.0");
    expect(opened.report.schemaVersion).to.equal("2");
    expect(opened.input).to.deep.equal({ template: input.template });
    expect(opened.run.sourceRetained).to.equal(false);
    expect((await context.owner()).pendingJobCount).to.equal(0);
    const original = JSON.stringify(opened.report);
    await context.history.processJob(context.messages[0]);
    expect(JSON.stringify((await context.client().open(project.projectId, run.runId)).report)).to.equal(original);
    expect(analyses).to.equal(1);
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    expect(context.artifacts.objects.has(context.messages[0].inputKey)).to.equal(false);
    expect([...context.artifacts.objects.keys()]).to.have.length(3);
  });

  it("preserves source opt-in, independent saved comparison, expiry and historical versions", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "source");
    const first = await context.history.submit("alice", project.projectId, { ...request(), retainSource: true });
    await context.history.processJob(context.messages[0]);
    const opened = await context.history.open("alice", project.projectId, first.run.runId);
    expect(opened.input).to.deep.equal(input);
    const child = await context.history.derive("alice", project.projectId, first.run.runId, "reanalysis", { idempotencyKey: "reanalysis-child", retainSource: true });
    const comparison = await context.history.compare("alice", { projectId: project.projectId, runId: first.run.runId }, { projectId: project.projectId, runId: child.run.runId });
    expect(comparison.oldReport.sourceAnalysis).to.deep.equal(opened.report.sourceAnalysis);
    expect((await context.history.open("alice", project.projectId, first.run.runId)).report).to.deep.equal(opened.report);
    context.advance(7 * 86400_000 + 1);
    expect((await context.history.open("alice", project.projectId, first.run.runId)).input).to.equal(undefined);
    await rejects(context.history.download("alice", project.projectId, first.run.runId, "input"), 410);
  });

  it("keeps owner-scoped idempotency, quotas and conflicting request rejection", async () => {
    const context = setup({ quotas: { pendingJobsPerUser: 1 } });
    const project = await context.history.createProject("alice", "quotas");
    const first = await context.history.submit("alice", project.projectId, request());
    const again = await context.history.submit("alice", project.projectId, request());
    expect(again.run.runId).to.equal(first.run.runId);
    expect((await context.owner()).runCount).to.equal(1);
    expect((await context.owner()).saveKeyCount).to.equal(1);
    await rejects(context.history.submit("alice", project.projectId, { ...request(), retainSource: true }), 409);
    await rejects(context.history.submit("alice", project.projectId, request("new-pending-key")), 409);
    await rejects(context.history.status("bob", project.projectId, first.run.runId), 404);
    await rejects(context.history.download("bob", project.projectId, first.run.runId, "input"), 404);
    await rejects(context.history.submit("bob", project.projectId, request()), 404);
    await context.history.processJob(context.messages[0]);
    await context.history.submit("alice", project.projectId, request("next-pending-key"));
    expect((await context.owner()).pendingJobCount).to.equal(1);
  });

  it("serializes racing reservations and releases pending quota exactly once on deletion", async () => {
    const context = setup({ quotas: { pendingJobsPerUser: 1 } });
    const project = await context.history.createProject("alice", "reservation race");
    const results = await Promise.allSettled([
      context.history.submit("alice", project.projectId, request("racing-first-key")),
      context.history.submit("alice", project.projectId, request("racing-other-key"))
    ]);
    expect(results.filter(result => result.status === "fulfilled")).to.have.length(1);
    expect((await context.owner()).pendingJobCount).to.equal(1);
    const winner = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<HistoryService["submit"]>>>;
    await context.history.deleteRun("alice", project.projectId, winner.value.run.runId);
    await context.history.deleteRun("alice", project.projectId, winner.value.run.runId);
    expect((await context.owner()).pendingJobCount).to.equal(0);
    expect((await context.owner()).runCount).to.equal(0);
    await context.history.processJob(context.messages[0]);
    await rejects(context.history.status("alice", project.projectId, winner.value.run.runId), 404);
    const winnerKey = results[0].status === "fulfilled" ? "racing-first-key" : "racing-other-key";
    await rejects(context.history.submit("alice", project.projectId, request(winnerKey)), 410);
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    expect(context.artifacts.objects.size).to.equal(0);
  });

  it("retries failed immutable output writes with a fresh attempt and cleans the losing manifest", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "output recovery");
    const saved = await context.history.submit("alice", project.projectId, request());
    context.artifacts.failOutput = true;
    await rejects(context.history.processJob(context.messages[0]));
    const losing = await context.record(project.projectId, saved.run.runId);
    context.artifacts.failOutput = false;
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    await context.history.processJob(context.messages.at(-1)!);
    expect((await context.history.open("alice", project.projectId, saved.run.runId)).run.job!.attempts).to.equal(2);
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    for (const key of Object.values(losing.artifacts)) expect(context.artifacts.objects.has(key)).to.equal(false);
    expect(context.artifacts.objects.size).to.equal(3);
  });

  it("recovers a send failure after metadata acceptance without creating a second run", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "missed send");
    context.queue.fail = true;
    const saved = await context.history.submit("alice", project.projectId, request());
    expect(saved.run.job!.status).to.equal("PENDING_DISPATCH");
    context.queue.fail = false;
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    expect(context.messages).to.have.length(1);
    await context.history.processJob(context.messages[0]);
    expect((await context.history.status("alice", project.projectId, saved.run.runId)).job!.status).to.equal("SUCCEEDED");
    expect((await context.owner()).runCount).to.equal(1);
  });

  it("does not let a late dispatch acknowledgement overwrite a completed result", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "ack race");
    context.queue.onSend = message => context.history.processJob(message);
    const saved = await context.history.submit("alice", project.projectId, request());
    expect(saved.run.job!.status).to.equal("SUCCEEDED");
    expect(saved.run.job!.attempts).to.equal(1);
  });

  it("claims duplicate deliveries once while an analyzer is running", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const context = setup({ analyze: async value => { calls++; entered(); await gate; return analyze(JSON.stringify(value)); } });
    const project = await context.history.createProject("alice", "duplicate");
    const saved = await context.history.submit("alice", project.projectId, request());
    const worker = context.history.processJob(context.messages[0]);
    await started;
    expect((await context.history.status("alice", project.projectId, saved.run.runId)).job!.status).to.equal("RUNNING");
    await context.history.processJob(context.messages[0]);
    release();
    await worker;
    expect(calls).to.equal(1);
    expect((await context.owner()).pendingJobCount).to.equal(0);
  });

  it("recovers a crashed worker and fences an old worker after its lease expires", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const context = setup({ analyze: async value => { if (++calls === 1) { entered(); await gate; }
      return analyze(JSON.stringify(value)); } });
    const project = await context.history.createProject("alice", "stale worker");
    const saved = await context.history.submit("alice", project.projectId, request());
    const old = context.history.processJob(context.messages[0]);
    const oldFailure = rejects(old, 409);
    await started;
    const firstAttempt = (await context.record(project.projectId, saved.run.runId)).attempt;
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    await context.history.processJob(context.messages.at(-1)!);
    const winner = await context.record(project.projectId, saved.run.runId);
    expect(winner.attempt).not.to.equal(firstAttempt);
    expect(winner.job!.attempts).to.equal(2);
    release();
    await oldFailure;
    const after = await context.record(project.projectId, saved.run.runId);
    expect(after.artifacts).to.deep.equal(winner.artifacts);
    expect(after.job!.status).to.equal("SUCCEEDED");
  });

  it("retries infrastructure failures, returns partial failures, and eventually exposes exhausted attempts", async () => {
    const context = setup({ analyze: async () => { throw new Error("temporary storage failure"); } });
    const project = await context.history.createProject("alice", "poison");
    const saved = await context.history.submit("alice", project.projectId, request());
    const worker = createAnalysisWorker(context.history);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await worker({ Records: [{ messageId: `attempt-${attempt}`, body: JSON.stringify(context.messages.at(-1)) }] });
      expect(response.batchItemFailures).to.deep.equal([{ itemIdentifier: `attempt-${attempt}` }]);
      context.advance(jobLeaseMs + 1);
      await context.history.reconcileJobs();
    }
    const failed = await context.history.status("alice", project.projectId, saved.run.runId);
    expect(failed.job).to.include({ status: "FAILED", failure: "RETRIES_EXHAUSTED", attempts: 3 });
    expect((await context.owner()).pendingJobCount).to.equal(0);
    await rejects(context.history.open("alice", project.projectId, saved.run.runId), 404);
    expect((await context.history.listRuns("alice", project.projectId, 20)).items[0].job!.status).to.equal("FAILED");
  });

  it("marks terminal invalid input without retrying or exposing raw validation errors", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "invalid");
    const saved = await context.history.submit("alice", project.projectId, { ...request(), input: { template: "invalid yaml: [" } });
    const response = await createAnalysisWorker(context.history)({ Records: [{ messageId: "invalid", body: JSON.stringify(context.messages[0]) }] });
    expect(response.batchItemFailures).to.deep.equal([]);
    expect((await context.history.status("alice", project.projectId, saved.run.runId)).job).to.include({ status: "FAILED", failure: "INVALID_INPUT", attempts: 1 });
  });

  it("reconciles a DLQ job into visible failure and retries with a new linked run and explicit reupload", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "DLQ");
    const saved = await context.client().submit(project.projectId, request());
    await rejects(context.history.submit("alice", project.projectId, request("premature-retry"), saved.run.runId), 409);
    await context.history.processJob(context.messages[0], true);
    const failed = await context.client().status(project.projectId, saved.run.runId);
    expect(failed.job).to.include({ status: "FAILED", failure: "DEAD_LETTER" });
    const retried = await context.client().retry(project.projectId, saved.run.runId, request("retry-with-input"));
    expect(retried.run.runId).not.to.equal(saved.run.runId);
    expect(retried.run.provenance).to.deep.equal({ kind: "retry", parentRun: { projectId: project.projectId, runId: saved.run.runId }, inputMode: "reuploaded" });
    expect((await context.client().retry(project.projectId, saved.run.runId, request("retry-with-input"))).run.runId).to.equal(retried.run.runId);
    await context.history.processJob(context.messages.at(-1)!);
    expect((await context.client().status(project.projectId, saved.run.runId)).job).to.deep.equal(failed.job);
  });

  it("recovers missing queue delivery and fails dispatch intent at a bounded deadline", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "never delivered");
    const saved = await context.history.submit("alice", project.projectId, request());
    context.advance(jobRecoveryMs + 1);
    await context.history.reconcileJobs();
    expect(context.messages).to.have.length(2);
    context.advance(jobDeadlineMs);
    await context.history.reconcileJobs();
    expect((await context.history.status("alice", project.projectId, saved.run.runId)).job).to.include({ status: "FAILED", failure: "DISPATCH_TIMEOUT" });
  });

  it("keeps input upload failures retry-safe and cleans abandoned staging reservations", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "staging");
    context.artifacts.failInput = true;
    await rejects(context.history.submit("alice", project.projectId, request()));
    expect(context.messages).to.have.length(0);
    context.artifacts.failInput = false;
    const saved = await context.history.submit("alice", project.projectId, request());
    expect((await context.owner()).runCount).to.equal(1);
    await context.history.processJob(context.messages[0]);
    expect((await context.history.status("alice", project.projectId, saved.run.runId)).job!.status).to.equal("SUCCEEDED");
    context.artifacts.failInput = true;
    await rejects(context.history.submit("alice", project.projectId, request("abandoned-upload")));
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    const jobs = (await context.history.listRuns("alice", project.projectId, 20)).items;
    expect(jobs.find(run => run.runId !== saved.run.runId)!.job).to.include({ status: "FAILED", failure: "DISPATCH_TIMEOUT" });
    expect((await context.owner()).pendingJobCount).to.equal(0);
  });

  it("renews an expired staging reservation before resumed upload so deletion cannot race its writes", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "resumed staging writer");
    context.artifacts.failInput = true;
    await rejects(context.history.submit("alice", project.projectId, request()));
    context.advance(jobLeaseMs + 1);
    context.artifacts.failInput = false;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    context.artifacts.beforeInputPut = async () => { entered(); await gate; };
    const resumed = context.history.submit("alice", project.projectId, request());
    const rejected = rejects(resumed, 404);
    await started;
    expect((await context.history.deleteProject("alice", project.projectId)).cleanupPending).to.equal(true);
    release();
    await rejected;
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    expect(context.artifacts.objects.size).to.equal(0);
    expect((await context.owner()).pendingJobCount).to.equal(0);
  });

  it("keeps deletion authoritative during execution and cleans all durable attempt manifests after the lease", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const context = setup({ analyze: async value => { entered(); await gate; return analyze(JSON.stringify(value)); } });
    const project = await context.history.createProject("alice", "delete active");
    const saved = await context.history.submit("alice", project.projectId, request());
    const worker = context.history.processJob(context.messages[0]);
    const failedWorker = rejects(worker, 404);
    await started;
    expect((await context.history.deleteProject("alice", project.projectId)).cleanupPending).to.equal(true);
    await rejects(context.history.status("alice", project.projectId, saved.run.runId), 404);
    release();
    await failedWorker;
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    expect(context.artifacts.objects.size).to.equal(0);
    expect((await context.owner()).pendingJobCount).to.equal(0);
    expect((await context.record(project.projectId, saved.run.runId)).state).to.equal("deleted");
    await context.history.processJob(context.messages[0]);
    await rejects(context.history.open("alice", project.projectId, saved.run.runId), 404);
  });

  it("does not publish a retry after its failed parent is deleted", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "deleted parent");
    const parent = await context.history.submit("alice", project.projectId, request());
    await context.history.processJob(context.messages[0], true);
    const child = await context.history.submit("alice", project.projectId, request("retry-parent-delete"), parent.run.runId);
    await context.history.deleteRun("alice", project.projectId, parent.run.runId);
    await context.history.processJob(context.messages.at(-1)!);
    expect((await context.history.status("alice", project.projectId, child.run.runId)).job).to.include({ status: "FAILED", failure: "PARENT_DELETED" });
  });

  it("does not clean active async work through legacy expired-save cleanup", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "maintenance");
    const saved = await context.history.submit("alice", project.projectId, request());
    context.advance(jobLeaseMs + 1);
    await context.history.cleanup("alice", 20);
    expect((await context.history.status("alice", project.projectId, saved.run.runId)).job!.status).to.equal("QUEUED");
  });

  it("rejects tampered references and input bytes, and reports malformed messages as partial failures", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "integrity");
    const saved = await context.history.submit("alice", project.projectId, request());
    await rejects(context.history.processJob({ ...context.messages[0], inputKey: "other-owner-input" }));
    context.artifacts.objects.set(context.messages[0].inputKey, "tampered");
    await context.history.processJob(context.messages[0]);
    expect((await context.history.status("alice", project.projectId, saved.run.runId)).job!.failure).to.equal("INVALID_INPUT");
    const response = await createAnalysisWorker(context.history)({ Records: [
      { messageId: "bad-json", body: "invalid" }, { messageId: "done", body: JSON.stringify(context.messages[0]) } ] });
    expect(response.batchItemFailures).to.deep.equal([{ itemIdentifier: "bad-json" }]);
    expect(() => parseAnalysisMessage(JSON.stringify({ ...context.messages[0], template: "raw" }))).to.throw();
  });

  it("retries cleanup failures through durable recovery without republishing reports", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "cleanup retry");
    const saved = await context.history.submit("alice", project.projectId, request());
    await context.history.processJob(context.messages[0]);
    context.advance(jobLeaseMs + 1);
    context.artifacts.failDelete = true;
    await rejects(context.history.reconcileJobs());
    expect((await context.record(project.projectId, saved.run.runId)).recoveryShard).not.to.equal(undefined);
    context.artifacts.failDelete = false;
    context.advance(jobLeaseMs + 1);
    await context.history.reconcileJobs();
    expect((await context.record(project.projectId, saved.run.runId)).recoveryShard).to.equal(undefined);
    expect((await context.history.open("alice", project.projectId, saved.run.runId)).run.job!.attempts).to.equal(1);
  });

  it("expires processing input and bounds the recovery query and polling backoff", async () => {
    const context = setup();
    const project = await context.history.createProject("alice", "expiry");
    const saved = await context.history.submit("alice", project.projectId, request());
    const run = await context.record(project.projectId, saved.run.runId);
    await context.store.commit([write("runs", { ...run, inputExpiresAt: "2026-10-20T00:00:00Z" }, run)]);
    await context.history.processJob(context.messages[0]);
    expect((await context.history.status("alice", project.projectId, saved.run.runId)).job!.failure).to.equal("INPUT_EXPIRED");
    expect([0, 1, 2, 3, 4, 100].map(analysisPollDelay)).to.deep.equal([2000, 4000, 8000, 16000, 30000, 30000]);
    const queried: number[] = [];
    const original = context.store.dueJobs.bind(context.store);
    context.store.dueJobs = async (shard, now, limit) => { queried.push(limit); return original(shard, now, limit); };
    await context.history.reconcileJobs();
    expect(queried).to.deep.equal([25, 25, 25, 25]);
  });
});
