import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  ArtifactStore,
  HistoryStore,
  HistoryTable,
  ProjectStore,
  RecordKey,
  StoredRecord,
  Write
} from "./historyStore";

export class AwsHistoryStore implements HistoryStore {
  projects: ProjectStore;

  runs: ProjectStore;

  constructor(
    private tables: Record<HistoryTable, string>,
    private client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true }
    })
  ) {
    this.projects = this.reader("projects");
    this.runs = this.reader("runs");
  }

  async commit(writes: Write[]): Promise<boolean> {
    if (writes.length === 0) {
      return true;
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: writes.map((operation) => this.transactionWrite(operation))
        })
      );
      return true;
    } catch (error) {
      const failure = error as {
        name?: string;
        CancellationReasons?: { Code?: string }[];
      };
      if (
        failure.name === "TransactionCanceledException" &&
        failure.CancellationReasons?.some(
          (reason) =>
            reason.Code === "ConditionalCheckFailed" || reason.Code === "TransactionConflict"
        )
      ) {
        return false;
      }
      throw error;
    }
  }

  private transactionWrite(operation: Write) {
    const item = {
      TableName: this.tables[operation.table],
      Item: operation.item
    };

    if (operation.expected === undefined) {
      return {
        Put: { ...item, ConditionExpression: "attribute_not_exists(pk)" }
      };
    }

    return {
      Put: {
        ...item,
        ConditionExpression: "#v = :v",
        ExpressionAttributeNames: { "#v": "version" },
        ExpressionAttributeValues: { ":v": operation.expected }
      }
    };
  }

  private reader(table: HistoryTable): ProjectStore {
    return {
      get: async <T extends StoredRecord>(key: RecordKey) => {
        const result = await this.client.send(
          new GetCommand({
            TableName: this.tables[table],
            Key: key,
            ConsistentRead: true
          })
        );
        return result.Item as T | undefined;
      },
      query: async <T extends StoredRecord>(
        partitionKey: string,
        prefix: string,
        limit: number,
        after?: string
      ) => {
        const result = await this.client.send(
          new QueryCommand({
            TableName: this.tables[table],
            ConsistentRead: true,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": partitionKey,
              ":prefix": prefix
            },
            Limit: limit,
            ScanIndexForward: true,
            ...(after
              ? {
                  ExclusiveStartKey: {
                    pk: partitionKey,
                    sk: after
                  }
                }
              : {})
          })
        );
        return {
          items: (result.Items ?? []) as T[],
          ...(result.LastEvaluatedKey ? { after: String(result.LastEvaluatedKey.sk) } : {})
        };
      }
    };
  }
}

export class S3ArtifactStore implements ArtifactStore {
  constructor(
    private bucket: string,
    private client = new S3Client({})
  ) {}

  async put(key: string, body: string, kind: "report" | "input"): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: key.endsWith(".md") ? "text/markdown" : "application/json",
        ServerSideEncryption: "AES256",
        Tagging: `retention=${kind}`
      })
    );
  }

  async get(key: string): Promise<string> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );
    if (!result.Body) {
      throw new Error("Artifact unavailable");
    }
    return result.Body.transformToString();
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );
  }

  signedDownload(key: string, seconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: "attachment"
      }),
      { expiresIn: seconds }
    );
  }
}
