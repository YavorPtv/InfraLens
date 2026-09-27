import type { SavedProject, SavedRun } from "@infralens/shared";

export type HistoryTable = "projects" | "runs";

export interface RecordKey {
  pk: string;
  sk: string;
}

export interface StoredRecord extends RecordKey {
  version: number;
}

export interface OwnerRecord extends StoredRecord {
  projectCount: number;
  runCount: number;
  saveKeyCount: number;
  cursorSecret: string;
}

export interface ProjectRecord extends StoredRecord, SavedProject {
  cleanupAfter?: string;
  state: "active" | "deleted";
  runCount: number;
}

export interface RunRecord extends StoredRecord, SavedRun {
  expiresAt?: number;
  state: "pending" | "completed" | "deleted";
  leaseUntil: number;
  attempt: string;
  artifacts: Record<"report" | "markdown" | "input", string>;
  cleaned: boolean;
}

export interface IdempotencyRecord extends StoredRecord {
  hash: string;
  projectId: string;
  runId: string;
}

export interface Write {
  table: HistoryTable;
  item: StoredRecord;
  /** undefined means the item must not exist. */
  expected?: number;
}

export interface RecordPage<T> {
  items: T[];
  after?: string;
}

export interface ProjectStore {
  get<T extends StoredRecord>(key: RecordKey): Promise<T | undefined>;
  query<T extends StoredRecord>(
    partitionKey: string,
    prefix: string,
    limit: number,
    after?: string
  ): Promise<RecordPage<T>>;
}

export interface RunStore extends ProjectStore {}

export interface HistoryStore {
  projects: ProjectStore;
  runs: RunStore;
  /** Atomic compare-and-swap across both tables. Only conditional conflicts return false. */
  commit(writes: Write[]): Promise<boolean>;
}

export interface ArtifactStore {
  put(key: string, body: string, kind: "report" | "input"): Promise<void>;
  get(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  signedDownload(key: string, seconds: number): Promise<string>;
}

export function write<T extends StoredRecord>(
  table: HistoryTable,
  item: T,
  previous?: StoredRecord
): Write {
  return {
    table,
    item: {
      ...item,
      version: (previous?.version ?? 0) + 1
    },
    expected: previous?.version
  };
}

/** Credential-free adapter. A commit has no await points, matching transaction atomicity. */
export class MemoryHistoryStore implements HistoryStore {
  private tables = {
    projects: new Map<string, StoredRecord>(),
    runs: new Map<string, StoredRecord>()
  };

  projects = this.reader("projects");

  runs = this.reader("runs");

  async commit(writes: Write[]): Promise<boolean> {
    if (
      writes.some(
        (writeOperation) =>
          this.tables[writeOperation.table].get(this.key(writeOperation.item))?.version !==
          writeOperation.expected
      )
    ) {
      return false;
    }
    for (const writeOperation of writes) {
      this.tables[writeOperation.table].set(
        this.key(writeOperation.item),
        structuredClone(writeOperation.item)
      );
    }
    return true;
  }

  private key(key: RecordKey): string {
    return JSON.stringify([key.pk, key.sk]);
  }

  private reader(table: HistoryTable): ProjectStore {
    return {
      get: async <T extends StoredRecord>(key: RecordKey) =>
        structuredClone(this.tables[table].get(this.key(key))) as T | undefined,
      query: async <T extends StoredRecord>(
        partitionKey: string,
        prefix: string,
        limit: number,
        after?: string
      ) => {
        const matchingRecords = [...this.tables[table].values()]
          .filter(
            (record) =>
              record.pk === partitionKey &&
              record.sk.startsWith(prefix) &&
              (!after || record.sk > after)
          )
          .sort((left, right) => {
            if (left.sk < right.sk) {
              return -1;
            }
            if (left.sk > right.sk) {
              return 1;
            }
            return 0;
          });
        const items = matchingRecords.slice(0, limit);
        return {
          items: structuredClone(items) as T[],
          ...(matchingRecords.length > limit ? { after: items.at(-1)!.sk } : {})
        };
      }
    };
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, string>();

  async put(key: string, body: string): Promise<void> {
    this.objects.set(key, body);
  }

  async get(key: string): Promise<string> {
    const body = this.objects.get(key);
    if (body === undefined) {
      throw new Error("Artifact unavailable");
    }
    return body;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async signedDownload(): Promise<string> {
    throw new Error("Local artifacts are returned through the authenticated artifact endpoint.");
  }
}
