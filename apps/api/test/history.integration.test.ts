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
