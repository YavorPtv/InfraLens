import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import {
  analysisVersions,
  canDownloadGeneratedTemplate,
  exportAnalysisReportToMarkdown,
  type ApplySavedRunRequest,
  type DeriveRunRequest,
  type RunProvenance,
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
  applyValidatedBody,
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
  report: AnalysisReport;
  derivation?: Derivation;
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

interface Derivation {
  provenance: RunProvenance;
  identity: unknown;
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
    ...analysisVersions(runRecord),
    summary: runRecord.summary,
    resourceCount: runRecord.resourceCount,
    score: runRecord.score,
    sourceStatus: runRecord.sourceStatus ?? "unknown",
    provenance: runRecord.provenance,
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

  async save(ownerId: string, projectId: string, request: SaveAnalysisRequest): Promise<OpenSavedRun> {
    return this.saveRun(ownerId, projectId, request);
  }

  private async saveRun(
    ownerId: string,
    projectId: string,
    request: SaveAnalysisRequest,
    derivation?: Derivation
  ): Promise<OpenSavedRun> {
    const limits = this.options.limits ?? defaultApiRequestLimits;
    const input = parseAnalyzeApiRequest(JSON.stringify(request.input), limits);
    const requestHash = hashRequestValue(
      canonicalizeRequest(derivation?.identity ?? {
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
      report,
      derivation,
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
      template: input.template,
      input: retained
    };
  }

  private checkDerivedExpiry(parent?: RunRecord, provenance?: RunProvenance): void {
    if (parent && provenance?.inputMode !== "reuploaded" && this.now() >= Date.parse(parent.inputExpiresAt)) {
      throwHistoryError(410, "INPUT_EXPIRED", "Retained inputs expired. Reupload the template and source to continue.");
    }
  }

  /** Derivations accept selections and inputs, never browser reports or generated patches. */
  async derive(
    ownerId: string,
    projectId: string,
    runId: string,
    kind: "apply" | "reanalysis",
    request: DeriveRunRequest | ApplySavedRunRequest
  ): Promise<OpenSavedRun> {
    const parent = await this.getCompletedRun(ownerId, projectId, runId);
    if (kind === "apply") {
      const ids = (request as ApplySavedRunRequest).fixIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
        throwHistoryError(400, "INVALID_REQUEST", "Select 1–100 unique fix IDs.");
      }
    }
    const identity = { project: projectId, parent: runId, kind, request };
    const previous = await this.store.projects.get<IdempotencyRecord>({
      pk: ownerPartitionKey(ownerId), sk: `IDEMPOTENCY#${hashRequestValue(request.idempotencyKey)}`
    });
    if (previous) {
      if (previous.hash !== hashRequestValue(canonicalizeRequest(identity))) {
        throwHistoryError(409, "CONFLICT", "Idempotency key already used for a different request.");
      }
      const child = await this.store.runs.get<RunRecord>(runKey(ownerId, projectId, previous.runId));
      if (!child || child.state === "deleted") throwHistoryError(410, "GONE", "Child run was deleted. Use a new key.");
      if (child.state === "completed") return this.open(ownerId, projectId, child.runId);
      if (child.leaseUntil > this.now()) return throwSaveConflict();
    }
    const limits = this.options.limits ?? defaultApiRequestLimits;
    const saved = await this.open(ownerId, projectId, runId);
    let input = request.input === undefined ? saved.input : parseAnalyzeApiRequest(JSON.stringify(request.input), limits);
    if (!input) throwHistoryError(410, "INPUT_EXPIRED", "Retained inputs expired. Reupload the template and source to continue.");
    const sourceWasProvided = (parent.sourceStatus ?? saved.report.sourceAnalysis?.status ?? "unknown") !== "missing";
    if (sourceWasProvided && input.sourceFiles === undefined && request.templateOnly !== true) {
      throwHistoryError(400, "INVALID_REQUEST", "Source is unavailable or unknown. Reupload source or explicitly choose template-only analysis.");
    }
    if (request.templateOnly) {
      input = { template: input.template };
    }
    const provenance: RunProvenance = {
      kind, parentRun: { projectId, runId },
      inputMode: request.input ? "reuploaded" : request.templateOnly ? "template-only" : "retained"
    };
    if (kind === "apply") {
      const fixIds = (request as ApplySavedRunRequest).fixIds;
      // A reupload must match the original bytes/context. Legacy records can use retained input;
      // without a digest an expired legacy template must first be explicitly reanalyzed.
      const templateMatches = parent.templateDigest === hashRequestValue(input.template);
      const contextMatches = parent.inputDigest === hashRequestValue(canonicalizeRequest(input));
      if (request.input && (!templateMatches || (!request.templateOnly && !contextMatches))) {
        throwHistoryError(409, "CONFLICT", "Reuploaded input differs from the original or cannot be verified. Reanalyze before applying fixes.");
      }
      const current = await analyzeValidatedBody(JSON.stringify(input), undefined, limits);
      const fixes = fixIds.map(id => {
        const original = saved.report.templateFixes?.find(fix => fix.id === id);
        const fresh = current.templateFixes?.find(fix => fix.id === id);
        if (!original || !fresh || fresh.applicability !== "applicable" || canonicalizeRequest(original) !== canonicalizeRequest(fresh)) {
          return throwHistoryError(409, "CONFLICT", "Selected fixes are stale or unavailable. Reanalyze before applying fixes.");
        }
        return fresh;
      });
      const applied = await applyValidatedBody(JSON.stringify({ template: input.template, fixes }), undefined, limits);
      if (applied.failedFixCount || !canDownloadGeneratedTemplate(applied.validation)) {
        throwHistoryError(409, "CONFLICT", "Selected fixes conflict or the generated template is invalid. Reanalyze and review the fixes.");
      }
      provenance.appliedFixIds = fixIds;
      input = { ...input, template: JSON.stringify(applied.modifiedTemplate, null, 2) + "\n" };
    }
    return this.saveRun(ownerId, projectId, {
      input,
      idempotencyKey: request.idempotencyKey,
      retainSource: request.retainSource
    }, { provenance, identity });
  }

  private reserveRun(reservation: RunReservation): Promise<RunRecord> {
    const {
      ownerId,
      projectId,
      idempotencyKey,
      requestHash,
      previousSave,
      input,
      report,
      derivation,
      retainSource,
      retainedBody,
      attempt,
      runId
    } = reservation;

    return this.commitWithRetry(async () => {
      const projectRecord = await this.getProject(ownerId, projectId);
      const parent = derivation ? await this.getCompletedRun(ownerId, projectId, derivation.provenance.parentRun.runId) : undefined;
      this.checkDerivedExpiry(parent, derivation?.provenance);
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
        ...analysisVersions(report),
        summary: report.summary,
        resourceCount: report.resources.length,
        score: report.score,
        sourceStatus: report.sourceAnalysis?.status ?? "unknown",
        ...(derivation ? { provenance: derivation.provenance } : {}),
        inputDigest: hashRequestValue(canonicalizeRequest(input)),
        templateDigest: hashRequestValue(input.template),
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
        sourceRetained: retainSource === true && input.sourceFiles !== undefined,
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
      if (parent) writes.push(write("runs", parent, parent));
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
      const parent = current.provenance ? await this.getCompletedRun(ownerId, projectId, current.provenance.parentRun.runId) : undefined;
      this.checkDerivedExpiry(parent, current.provenance);
      return {
        value: undefined,
        writes: [
          ...(parent ? [write("runs", parent, parent)] : []),
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
    Object.assign(report, analysisVersions(report));
    let input: AnalyzeApiRequest | undefined;
    if (this.now() < Date.parse(runRecord.inputExpiresAt)) {
      const retained = JSON.parse(await this.artifacts.get(runRecord.artifacts.input)) as AnalyzeApiRequest;
      input = runRecord.sourceRetained ? retained : { template: retained.template };
    }
    await this.getCompletedRun(ownerId, projectId, runId);
    if (this.now() >= Date.parse(runRecord.inputExpiresAt)) input = undefined;
    return {
      run: toSavedRun(runRecord),
      report,
      ...(input === undefined ? {} : { template: input.template, input })
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
          "Retained inputs expired. Reupload templates and source on Compare."
        );
      }
      const input = JSON.parse(await this.artifacts.get(runRecord.artifacts.input)) as AnalyzeApiRequest;
      if (this.now() >= Date.parse(runRecord.inputExpiresAt)) {
        throwHistoryError(410, "INPUT_EXPIRED", "Retained inputs expired. Reupload templates and source on Compare.");
      }
      return runRecord.sourceRetained ? input : { template: input.template };
    };
    const oldInput = await read(oldRun);
    const newInput = await read(newRun);
    const oldRecord = await this.getCompletedRun(ownerId, oldRun.projectId, oldRun.runId);
    const newRecord = await this.getCompletedRun(ownerId, newRun.projectId, newRun.runId);
    if (this.now() >= Math.min(Date.parse(oldRecord.inputExpiresAt), Date.parse(newRecord.inputExpiresAt))) {
      throwHistoryError(410, "INPUT_EXPIRED", "Retained inputs expired. Reupload templates and source on Compare.");
    }
    const result = diffCloudFormationBody(
      JSON.stringify({
        oldTemplate: oldInput.template,
        newTemplate: newInput.template,
        oldSource: { sourceFiles: oldInput.sourceFiles, sourceFileMappings: oldInput.sourceFileMappings,
          sourceFileExclusions: oldInput.sourceFileExclusions },
        newSource: { sourceFiles: newInput.sourceFiles, sourceFileMappings: newInput.sourceFileMappings,
          sourceFileExclusions: newInput.sourceFileExclusions }
      }),
      undefined,
      this.options.limits ?? defaultApiRequestLimits
    );
    const oldVersions = analysisVersions(oldRecord);
    const newVersions = analysisVersions(newRecord);
    const currentVersions = analysisVersions(result.newReport);
    const versionsDiffer = [oldVersions, newVersions].some(versions =>
      versions.analyzerVersion !== currentVersions.analyzerVersion ||
      versions.schemaVersion !== currentVersions.schemaVersion
    );
    result.savedComparison = {
      old: oldVersions,
      new: newVersions,
      current: currentVersions,
      warnings: [
        "Comparison recomputes both inputs with the current analyzer; it does not replay historical saved output.",
        ...(versionsDiffer
          ? ["Saved analyzer/schema versions differ or are unknown. Historical finding counts may reflect analyzer changes as well as input changes."] : [])
      ]
    };
    return result;
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
