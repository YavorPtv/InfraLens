import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import {
  exportAnalysisReportToMarkdown,
  type AnalysisReport,
  type AnalyzeApiRequest,
  type HistoryPage,
  type OpenSavedRun,
  type SavedArtifact,
  type SavedProject,
  type SavedRun,
  type SaveAnalysisRequest,
  type SavedRunReference
} from "@infralens/shared";
import {
  ApiRequestError,
  analyzeValidatedBody,
  diffCloudFormationBody,
  parseAnalyzeApiRequest
} from "./analyzeRequest";
import type { ApiErrorCode } from "./analyzeRequest";
import { defaultApiRequestLimits, type ApiRequestLimits } from "./requestLimits";
import {
  MemoryArtifactStore,
  write,
  type ArtifactStore,
  type HistoryStore,
  type IdempotencyRecord,
  type OwnerRecord,
  type ProjectRecord,
  type RunRecord,
  type RecordKey,
  type Write
} from "./historyStore";

export interface HistoryQuotas {
  projectsPerUser: number;
  runsPerProject: number;
  runsPerUser: number;
  retainedInputBytes: number;
  saveKeysPerUser: number;
}

export interface HistoryServiceOptions {
  quotas?: Partial<HistoryQuotas>;
  now?: () => number;
  limits?: ApiRequestLimits;
  analyze?: (input: AnalyzeApiRequest) => Promise<AnalysisReport>;
}

interface RunReservation {
  ownerId: string;
  projectId: string;
  idempotencyKey: RecordKey;
  requestHash: string;
  previousSave?: IdempotencyRecord;
  input: AnalyzeApiRequest;
  retainSource?: boolean;
  retainedBody: string;
  attempt: string;
  runId: string;
}

export const defaultHistoryQuotas: HistoryQuotas = {
  projectsPerUser: 20,
  runsPerProject: 100,
  runsPerUser: 500,
  retainedInputBytes: 3 * 1024 * 1024,
  saveKeysPerUser: 10000
};

const leaseMs = 120_000;
// Exceeds the hosted Lambda's hard 30-second lifetime, including SDK retries.
const retentionMs = 7 * 86400_000;

const ownerPartitionKey = (ownerId: string) => `OWNER#${ownerId}`;

const projectKey = (ownerId: string, projectId: string) => ({
  pk: ownerPartitionKey(ownerId),
  sk: `PROJECT#${projectId}`
});

const runPartitionKey = (ownerId: string, projectId: string) =>
  `${ownerPartitionKey(ownerId)}#PROJECT#${projectId}`;

const runKey = (ownerId: string, projectId: string, run: string) => ({
  pk: runPartitionKey(ownerId, projectId),
  sk: `RUN#${run}`
});

function throwHistoryError(status: number, code: ApiErrorCode, message: string): never {
  throw new ApiRequestError(status, code, message);
}

const throwNotFound = (): never => throwHistoryError(404, "NOT_FOUND", "Project or run not found.");

const throwSaveConflict = (): never =>
  throwHistoryError(
    409,
    "CONFLICT",
    "Concurrent update or save in progress. Retry the same request shortly."
  );

function hashRequestValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalizeRequest(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeRequest).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);

    entries.sort(([leftKey], [rightKey]) => {
      if (leftKey < rightKey) {
        return -1;
      }
      if (leftKey > rightKey) {
        return 1;
      }
      return 0;
    });

    const properties = entries.map(([key, entryValue]) => {
      return `${JSON.stringify(key)}:${canonicalizeRequest(entryValue)}`;
    });

    return `{${properties.join(",")}}`;
  }
  return JSON.stringify(value);
}

function toSavedProject(projectRecord: ProjectRecord): SavedProject {
  return {
    projectId: projectRecord.projectId,
    name: projectRecord.name,
    createdAt: projectRecord.createdAt
  };
}

function toSavedRun(runRecord: RunRecord): SavedRun {
  return {
    projectId: runRecord.projectId,
    runId: runRecord.runId,
    createdAt: runRecord.createdAt,
    inputExpiresAt: runRecord.inputExpiresAt,
    sourceRetained: runRecord.sourceRetained,
    retainedInputBytes: runRecord.retainedInputBytes
  };
}

export class HistoryService {
  readonly quotas: HistoryQuotas;

  constructor(
    readonly store: HistoryStore,
    readonly artifacts: ArtifactStore,
    private options: HistoryServiceOptions = {}
  ) {
    this.quotas = {
      ...defaultHistoryQuotas,
      ...options.quotas
    };
    for (const [key, value] of Object.entries(this.quotas)) {
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > (key === "retainedInputBytes" ? 4 * 1024 * 1024 : 100000)
      ) {
        throw new Error(`Invalid history quota ${key}`);
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async commitWithRetry<T>(
    operation: () => Promise<{
      value: T;
      writes: Write[];
    }>
  ): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { value, writes } = await operation();
      if (await this.store.commit(writes)) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 5));
    }
    return throwSaveConflict();
  }

  private async getOrCreateOwner(ownerId: string): Promise<OwnerRecord> {
    const key = {
      pk: ownerPartitionKey(ownerId),
      sk: "OWNER"
    };
    const existing = await this.store.projects.get<OwnerRecord>(key);
    if (existing) {
      return existing;
    }
    const item: OwnerRecord = {
      ...key,
      version: 1,
      projectCount: 0,
      runCount: 0,
      saveKeyCount: 0,
      cursorSecret: randomBytes(32).toString("base64")
    };
    await this.store.commit([write("projects", item)]);
    return (
      (await this.store.projects.get<OwnerRecord>(key)) ??
      throwHistoryError(503, "UNAVAILABLE", "Storage unavailable.")
    );
  }

  private async getProject(
    ownerId: string,
    projectId: string,
    includeDeleted = false
  ): Promise<ProjectRecord> {
    const projectRecord = await this.store.projects.get<ProjectRecord>(
      projectKey(ownerId, projectId)
    );
    if (!projectRecord || (!includeDeleted && projectRecord.state !== "active")) {
      return throwNotFound();
    }
    return projectRecord;
  }

  async createProject(ownerId: string, name: string): Promise<SavedProject> {
    const projectId = randomUUID();
    return this.commitWithRetry(async () => {
      const ownerRecord = await this.getOrCreateOwner(ownerId);
      this.checkQuota(ownerRecord.projectCount, this.quotas.projectsPerUser);
      const projectRecord: ProjectRecord = {
        ...projectKey(ownerId, projectId),
        version: 0,
        projectId,
        name,
        createdAt: new Date(this.now()).toISOString(),
        state: "active",
        runCount: 0
      };
      return {
        value: toSavedProject(projectRecord),
        writes: [
          write("projects", projectRecord),
          write(
            "projects",
            {
              ...ownerRecord,
              projectCount: ownerRecord.projectCount + 1
            },
            ownerRecord
          )
        ]
      };
    });
  }

  async renameProject(ownerId: string, projectId: string, name: string): Promise<SavedProject> {
    return this.commitWithRetry(async () => {
      const projectRecord = await this.getProject(ownerId, projectId);
      return {
        value: toSavedProject({
          ...projectRecord,
          name
        }),
        writes: [
          write(
            "projects",
            {
              ...projectRecord,
              name
            },
            projectRecord
          )
        ]
      };
    });
  }

  async listProjects(
    ownerId: string,
    limit: number,
    cursor?: string
  ): Promise<HistoryPage<SavedProject>> {
    const after = await this.readCursor(ownerId, "projects", cursor);
    const page = await this.store.projects.query<ProjectRecord>(
      ownerPartitionKey(ownerId),
      "PROJECT#",
      limit,
      after
    );
    return {
      items: page.items
        .filter((projectRecord) => projectRecord.state === "active")
        .map(toSavedProject),
      ...(page.after
        ? { nextCursor: await this.createCursor(ownerId, "projects", page.after) }
        : {})
    };
  }

  async listRuns(
    ownerId: string,
    projectId: string,
    limit: number,
    cursor?: string
  ): Promise<HistoryPage<SavedRun>> {
    await this.getProject(ownerId, projectId);
    const after = await this.readCursor(ownerId, projectId, cursor);
    const page = await this.store.runs.query<RunRecord>(
      runPartitionKey(ownerId, projectId),
      "RUN#",
      limit,
      after
    );
    await this.getProject(ownerId, projectId);
    return {
      items: page.items.filter((runRecord) => runRecord.state === "completed").map(toSavedRun),
      ...(page.after ? { nextCursor: await this.createCursor(ownerId, projectId, page.after) } : {})
    };
  }

  async save(
    ownerId: string,
    projectId: string,
    request: SaveAnalysisRequest
  ): Promise<OpenSavedRun> {
    const limits = this.options.limits ?? defaultApiRequestLimits;
    const input = parseAnalyzeApiRequest(JSON.stringify(request.input), limits);
    const requestHash = hashRequestValue(
      canonicalizeRequest({
        project: projectId,
        input,
        retainSource: request.retainSource === true
      })
    );
    const idempotencyKey = {
      pk: ownerPartitionKey(ownerId),
      sk: `IDEMPOTENCY#${hashRequestValue(request.idempotencyKey)}`
    };
    await this.getProject(ownerId, projectId);
    const previousSave = await this.store.projects.get<IdempotencyRecord>(idempotencyKey);
    if (previousSave && previousSave.hash !== requestHash) {
      throwHistoryError(409, "CONFLICT", "Idempotency key already used for different input.");
    }
    if (previousSave) {
      const runRecord = await this.store.runs.get<RunRecord>(
        runKey(ownerId, projectId, previousSave.runId)
      );
      if (!runRecord || runRecord.state === "deleted") {
        throwHistoryError(
          410,
          "GONE",
          "The run for this idempotency key was deleted. Use a new key for a new save."
        );
      }
      if (runRecord.state === "completed") {
        return this.open(ownerId, projectId, runRecord.runId);
      }
      if (runRecord.leaseUntil > this.now()) {
        return throwSaveConflict();
      }
      // The lease has outlived the Lambda invocation. Clean the durable manifest before takeover.
      await this.removeArtifacts(runRecord);
    }
    const retained: AnalyzeApiRequest = request.retainSource ? input : { template: input.template };
    const retainedBody = JSON.stringify(retained);
    if (Buffer.byteLength(retainedBody) > this.quotas.retainedInputBytes) {
      throwHistoryError(413, "QUOTA_EXCEEDED", "Retained input exceeds the configured size quota.");
    }
    const report = await (this.options.analyze
      ? this.options.analyze(input)
      : analyzeValidatedBody(JSON.stringify(input), undefined, limits));
    const attempt = randomUUID();
    const runId =
      previousSave?.runId ?? `${this.now().toString().padStart(13, "0")}-${randomUUID()}`;
    const run = await this.reserveRun({
      ownerId,
      projectId,
      idempotencyKey,
      requestHash,
      previousSave,
      input,
      retainSource: request.retainSource,
      retainedBody,
      attempt,
      runId
    });

    // Keep artifacts if publication fails ambiguously: its transaction may have committed.
    await this.writeRunArtifacts(run, report, retainedBody);
    await this.publishRun(ownerId, projectId, runId, attempt);

    return {
      run: toSavedRun(run),
      report,
      template: input.template
    };
  }

  private reserveRun(reservation: RunReservation): Promise<RunRecord> {
    const {
      ownerId,
      projectId,
      idempotencyKey,
      requestHash,
      previousSave,
      input,
      retainSource,
      retainedBody,
      attempt,
      runId
    } = reservation;

    return this.commitWithRetry(async () => {
      const projectRecord = await this.getProject(ownerId, projectId);
      const ownerRecord = await this.getOrCreateOwner(ownerId);
      const idempotencyRecord = await this.store.projects.get<IdempotencyRecord>(idempotencyKey);
      if (idempotencyRecord && idempotencyRecord.hash !== requestHash) {
        throwHistoryError(409, "CONFLICT", "Idempotency key already used for different input.");
      }
      // A racing initial request must re-read the winner through the normal retry path.
      if (idempotencyRecord && !previousSave) {
        return throwSaveConflict();
      }
      const previousRun = idempotencyRecord
        ? await this.store.runs.get<RunRecord>(runKey(ownerId, projectId, idempotencyRecord.runId))
        : undefined;
      if (previousRun && (previousRun.state !== "pending" || previousRun.leaseUntil > this.now())) {
        return throwSaveConflict();
      }
      if (!previousRun) {
        this.checkQuota(projectRecord.runCount, this.quotas.runsPerProject);
        this.checkQuota(ownerRecord.runCount, this.quotas.runsPerUser);
        this.checkQuota(ownerRecord.saveKeyCount, this.quotas.saveKeysPerUser);
      }
      const prefix = `owners/${encodeURIComponent(ownerId)}/projects/${projectId}/runs/${runId}/${attempt}`;
      const runRecord: RunRecord = {
        ...runKey(ownerId, projectId, runId),
        version: 0,
        projectId: projectId,
        runId,
        createdAt: previousRun?.createdAt ?? new Date(this.now()).toISOString(),
        state: "pending",
        attempt,
        leaseUntil: this.now() + leaseMs,
        cleaned: false,
        artifacts: {
          report: `${prefix}/report.json`,
          markdown: `${prefix}/report.md`,
          input: `${prefix}/input.json`
        },
        inputExpiresAt: new Date(this.now() + retentionMs).toISOString(),
        sourceRetained: retainSource === true && Object.keys(input.sourceFiles ?? {}).length > 0,
        retainedInputBytes: Buffer.byteLength(retainedBody)
      };
      const writes = [
        write("runs", runRecord, previousRun),
        write(
          "projects",
          {
            ...projectRecord,
            runCount: projectRecord.runCount + (previousRun ? 0 : 1)
          },
          projectRecord
        )
      ];
      if (!idempotencyRecord) {
        const newIdempotencyRecord: IdempotencyRecord = {
          ...idempotencyKey,
          version: 0,
          hash: requestHash,
          projectId: projectId,
          runId
        };
        writes.push(
          write("projects", newIdempotencyRecord),
          write(
            "projects",
            {
              ...ownerRecord,
              runCount: ownerRecord.runCount + 1,
              saveKeyCount: ownerRecord.saveKeyCount + 1
            },
            ownerRecord
          )
        );
      }
      return {
        value: {
          ...runRecord,
          version: (previousRun?.version ?? 0) + 1
        },
        writes
      };
    });
  }

  private async writeRunArtifacts(
    run: RunRecord,
    report: AnalysisReport,
    retainedBody: string
  ): Promise<void> {
    await this.artifacts.put(run.artifacts.report, JSON.stringify(report), "report");
    await this.artifacts.put(
      run.artifacts.markdown,
      exportAnalysisReportToMarkdown(report),
      "report"
    );
    await this.artifacts.put(run.artifacts.input, retainedBody, "input");
  }

  private async publishRun(
    ownerId: string,
    projectId: string,
    runId: string,
    attempt: string
  ): Promise<void> {
    await this.commitWithRetry(async () => {
      const projectRecord = await this.getProject(ownerId, projectId);
      const current = await this.store.runs.get<RunRecord>(runKey(ownerId, projectId, runId));
      if (
        !current ||
        current.state !== "pending" ||
        current.attempt !== attempt ||
        current.leaseUntil <= this.now()
      ) {
        return throwSaveConflict();
      }
      return {
        value: undefined,
        writes: [
          write(
            "runs",
            {
              ...current,
              state: "completed",
              leaseUntil: 0
            } as RunRecord,
            current
          ),
          write("projects", projectRecord, projectRecord)
        ]
      };
    });
  }

  private async getCompletedRun(
    ownerId: string,
    projectId: string,
    runId: string
  ): Promise<RunRecord> {
    await this.getProject(ownerId, projectId);
    const runRecord = await this.store.runs.get<RunRecord>(runKey(ownerId, projectId, runId));
    if (!runRecord || runRecord.state !== "completed") {
      return throwNotFound();
    }
    return runRecord;
  }

  async open(ownerId: string, projectId: string, runId: string): Promise<OpenSavedRun> {
    const runRecord = await this.getCompletedRun(ownerId, projectId, runId);
    const report = JSON.parse(
      await this.artifacts.get(runRecord.artifacts.report)
    ) as AnalysisReport;
    let template: string | undefined;
    if (this.now() < Date.parse(runRecord.inputExpiresAt)) {
      template = (
        JSON.parse(await this.artifacts.get(runRecord.artifacts.input)) as AnalyzeApiRequest
      ).template;
    }
    await this.getCompletedRun(ownerId, projectId, runId);
    return {
      run: toSavedRun(runRecord),
      report,
      ...(template === undefined ? {} : { template })
    };
  }

  async download(
    ownerId: string,
    projectId: string,
    runId: string,
    kind: SavedArtifact
  ): Promise<
    | {
        url: string;
        expiresIn: number;
      }
    | { contents: string }
  > {
    const runRecord = await this.getCompletedRun(ownerId, projectId, runId);
    if (kind === "input" && this.now() >= Date.parse(runRecord.inputExpiresAt)) {
      throwHistoryError(
        410,
        "INPUT_EXPIRED",
        "Retained inputs expired. Reupload the template/source for reanalysis or comparison."
      );
    }
    const seconds =
      kind === "input"
        ? Math.min(60, Math.floor((Date.parse(runRecord.inputExpiresAt) - this.now()) / 1000))
        : 60;
    if (seconds < 1) {
      throwHistoryError(410, "INPUT_EXPIRED", "Retained inputs expired. Reupload to continue.");
    }
    const result =
      this.artifacts instanceof MemoryArtifactStore
        ? { contents: await this.artifacts.get(runRecord.artifacts[kind]) }
        : {
            url: await this.artifacts.signedDownload(runRecord.artifacts[kind], seconds),
            expiresIn: seconds
          };
    await this.getCompletedRun(ownerId, projectId, runId);
    return result;
  }

  async compare(ownerId: string, oldRun: SavedRunReference, newRun: SavedRunReference) {
    const read = async (ref: SavedRunReference) => {
      const runRecord = await this.getCompletedRun(ownerId, ref.projectId, ref.runId);
      if (this.now() >= Date.parse(runRecord.inputExpiresAt)) {
        throwHistoryError(
          410,
          "INPUT_EXPIRED",
          "Retained inputs expired. Reupload both templates on Compare."
        );
      }
      return (JSON.parse(await this.artifacts.get(runRecord.artifacts.input)) as AnalyzeApiRequest)
        .template;
    };
    const oldTemplate = await read(oldRun);
    const newTemplate = await read(newRun);
    await this.getCompletedRun(ownerId, oldRun.projectId, oldRun.runId);
    await this.getCompletedRun(ownerId, newRun.projectId, newRun.runId);
    return diffCloudFormationBody(
      JSON.stringify({
        oldTemplate,
        newTemplate
      }),
      undefined,
      this.options.limits ?? defaultApiRequestLimits
    );
  }

  async deleteRun(
    ownerId: string,
    projectId: string,
    runId: string,
    deletingProject = false,
    expiredOnly = false
  ): Promise<{
    deleted: true;
    cleanupPending: boolean;
  }> {
    await this.commitWithRetry(async () => {
      const projectRecord = await this.getProject(ownerId, projectId, deletingProject);
      const runRecord = await this.store.runs.get<RunRecord>(runKey(ownerId, projectId, runId));
      if (!runRecord) {
        return throwNotFound();
      }
      if (expiredOnly && (runRecord.state !== "pending" || runRecord.leaseUntil > this.now())) {
        return {
          value: undefined,
          writes: []
        };
      }
      if (runRecord.state === "deleted") {
        return {
          value: undefined,
          writes: []
        };
      }
      const ownerRecord = await this.getOrCreateOwner(ownerId);
      return {
        value: undefined,
        writes: [
          write(
            "runs",
            {
              ...runRecord,
              state: "deleted"
            } as RunRecord,
            runRecord
          ),
          write(
            "projects",
            {
              ...projectRecord,
              runCount: projectRecord.runCount - 1
            },
            projectRecord
          ),
          write(
            "projects",
            {
              ...ownerRecord,
              runCount: ownerRecord.runCount - 1
            },
            ownerRecord
          )
        ]
      };
    });
    const runRecord = (await this.store.runs.get<RunRecord>(runKey(ownerId, projectId, runId)))!;
    return {
      deleted: true,
      cleanupPending: !(await this.cleanupRun(runRecord))
    };
  }

  async deleteProject(
    ownerId: string,
    projectId: string
  ): Promise<{
    deleted: true;
    cleanupPending: boolean;
  }> {
    await this.commitWithRetry(async () => {
      const projectRecord = await this.getProject(ownerId, projectId, true);
      if (projectRecord.state === "deleted") {
        return {
          value: undefined,
          writes: []
        };
      }
      const ownerRecord = await this.getOrCreateOwner(ownerId);
      return {
        value: undefined,
        writes: [
          write(
            "projects",
            {
              ...projectRecord,
              state: "deleted"
            } as ProjectRecord,
            projectRecord
          ),
          write(
            "projects",
            {
              ...ownerRecord,
              projectCount: ownerRecord.projectCount - 1
            },
            ownerRecord
          )
        ]
      };
    });
    // Bounded work per invocation; repeated DELETE or cleanup resumes from tombstones.
    return {
      deleted: true,
      cleanupPending: await this.cleanupProject(ownerId, projectId)
    };
  }

  private async cleanupProject(ownerId: string, projectId: string): Promise<boolean> {
    let pending = false;
    const projectRecord = await this.getProject(ownerId, projectId, true);
    const page = await this.store.runs.query<RunRecord>(
      runPartitionKey(ownerId, projectId),
      "RUN#",
      25,
      projectRecord.cleanupAfter
    );
    for (const runRecord of page.items) {
      if (runRecord.cleaned) {
        continue;
      }
      if (
        projectRecord.state === "deleted" ||
        (runRecord.state === "pending" && runRecord.leaseUntil <= this.now())
      ) {
        const result = await this.deleteRun(
          ownerId,
          projectId,
          runRecord.runId,
          true,
          projectRecord.state !== "deleted"
        );
        if (result.cleanupPending) {
          pending = true;
        }
      } else if (runRecord.state === "deleted") {
        const cleaned = await this.cleanupRun(runRecord);
        if (!cleaned) {
          pending = true;
        }
      }
    }
    // Persist progress even across pages containing only cleaned tombstones. Without this,
    // a large deleted history could repeatedly exhaust the invocation before reaching its tail.
    const latest = await this.getProject(ownerId, projectId, true);
    const checkpointUnchanged = latest.cleanupAfter === projectRecord.cleanupAfter;
    const recorded =
      checkpointUnchanged &&
      (await this.store.commit([
        write(
          "projects",
          {
            ...latest,
            cleanupAfter: pending ? projectRecord.cleanupAfter : page.after
          },
          latest
        )
      ]));
    return (
      pending ||
      Boolean(page.after) ||
      !recorded ||
      (latest.state === "deleted" && latest.runCount > 0)
    );
  }

  /** Owner-scoped, explicit maintenance; no Scan or background credentials required. */
  async cleanup(
    ownerId: string,
    limit: number,
    cursor?: string
  ): Promise<{
    cleanupPending: boolean;
    nextCursor?: string;
  }> {
    const after = await this.readCursor(ownerId, "cleanup", cursor);
    const page = await this.store.projects.query<ProjectRecord>(
      ownerPartitionKey(ownerId),
      "PROJECT#",
      limit,
      after
    );
    let pending = false;
    for (const projectRecord of page.items) {
      const projectCleanupPending = await this.cleanupProject(ownerId, projectRecord.projectId);
      if (projectCleanupPending) {
        pending = true;
      }
    }
    return {
      cleanupPending: pending,
      ...(page.after ? { nextCursor: await this.createCursor(ownerId, "cleanup", page.after) } : {})
    };
  }

  private async cleanupRun(runRecord: RunRecord): Promise<boolean> {
    if (runRecord.state !== "deleted") {
      return false;
    }
    if (runRecord.cleaned) {
      return true;
    }
    if (runRecord.leaseUntil > this.now()) {
      return false;
    }
    try {
      await this.removeArtifacts(runRecord);
      return await this.store.commit([
        write(
          "runs",
          {
            ...runRecord,
            cleaned: true,
            expiresAt: Math.floor(this.now() / 1000) + 30 * 86400
          } as RunRecord,
          runRecord
        )
      ]);
    } catch {
      return false;
    } // Tombstone keeps cleanup discoverable and logical access closed.
  }

  private async removeArtifacts(runRecord: RunRecord): Promise<void> {
    for (const key of Object.values(runRecord.artifacts)) {
      await this.artifacts.delete(key);
    }
  }

  private checkQuota(count: number, maximum: number): void {
    if (count >= maximum) {
      throwHistoryError(
        409,
        "QUOTA_EXCEEDED",
        "Storage quota reached. Delete data or adjust the configured quota; old data is never silently removed."
      );
    }
  }

  private async createCursor(ownerId: string, scope: string, after: string): Promise<string> {
    const ownerRecord = await this.getOrCreateOwner(ownerId);
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(ownerRecord.cursorSecret, "base64"),
      iv
    );
    cipher.setAAD(Buffer.from(`${ownerId}\0${scope}`));
    const data = Buffer.concat([
      cipher.update(
        JSON.stringify({
          after,
          expires: this.now() + 3600_000
        })
      ),
      cipher.final()
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  private async readCursor(
    ownerId: string,
    scope: string,
    cursor?: string
  ): Promise<string | undefined> {
    if (!cursor) {
      return undefined;
    }
    const ownerRecord = await this.getOrCreateOwner(ownerId);
    try {
      if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error();
      }
      const data = Buffer.from(cursor, "base64url");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(ownerRecord.cursorSecret, "base64"),
        data.subarray(0, 12)
      );
      cipher.setAuthTag(data.subarray(12, 28));
      cipher.setAAD(Buffer.from(`${ownerId}\0${scope}`));
      const decoded = JSON.parse(
        Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString()
      );
      if (
        typeof decoded.after !== "string" ||
        typeof decoded.expires !== "number" ||
        decoded.expires <= this.now()
      ) {
        throw new Error();
      }
      return decoded.after;
    } catch {
      return throwHistoryError(400, "INVALID_REQUEST", "Invalid, expired, or out-of-scope cursor.");
    }
  }
}
