import { expect } from "chai";
import { describe, it } from "mocha";
import type { ApiOperationLogEntry } from "../src/operationLogging";
import { executeLoggedOperation } from "../src/operationLogging";
import {
  analyzeCloudFormationBody,
  ApiRequestError,
  diffCloudFormationBody
} from "../src/analyzeRequest";
import type { ApiRequestLimits } from "../src/requestLimits";

const emptyTemplate = JSON.stringify({ Resources: {} });

describe("API request limits", () => {
  it("keeps valid analysis behavior unchanged below the limits", () => {
    const report = analyzeCloudFormationBody(emptyTemplate, undefined, limits());

    expect(report.score).to.equal(100);
    expect(report.resources).to.deep.equal([]);
  });

  it("rejects an oversized template before analysis", () => {
    expectPayloadTooLarge(
      () => analyzeCloudFormationBody(emptyTemplate, undefined, limits({ maxTemplateBytes: 5 })),
      "CloudFormation template size"
    );
  });

  it("rejects too many source files", () => {
    const body = analysisEnvelope({ "one.ts": "one", "two.ts": "two" });

    expectPayloadTooLarge(
      () => analyzeCloudFormationBody(body, undefined, limits({ maxSourceFiles: 1 })),
      "Source file count"
    );
  });

  it("rejects an oversized individual source file", () => {
    const body = analysisEnvelope({ "large.ts": "123456" });

    expectPayloadTooLarge(
      () => analyzeCloudFormationBody(body, undefined, limits({ maxSourceFileBytes: 5 })),
      "Source file large.ts size"
    );
  });

  it("rejects excessive combined source size", () => {
    const body = analysisEnvelope({ "one.ts": "1234", "two.ts": "5678" });

    expectPayloadTooLarge(
      () => analyzeCloudFormationBody(body, undefined, limits({ maxCombinedSourceBytes: 7 })),
      "Combined source-code size"
    );
  });

  it("validates each diff template and their combined size", () => {
    const oversizedNewTemplate = JSON.stringify({ Resources: {}, padding: "1234567890" });
    const oneTemplateLimit = limits({ maxTemplateBytes: 25 });

    expectPayloadTooLarge(
      () =>
        diffCloudFormationBody(
          JSON.stringify({ oldTemplate: emptyTemplate, newTemplate: oversizedNewTemplate }),
          undefined,
          oneTemplateLimit
        ),
      "New CloudFormation template size"
    );

    expectPayloadTooLarge(
      () =>
        diffCloudFormationBody(
          JSON.stringify({ oldTemplate: emptyTemplate, newTemplate: emptyTemplate }),
          undefined,
          limits({ maxDiffTemplateBytes: emptyTemplate.length * 2 - 1 })
        ),
      "Combined diff template size"
    );
  });

  it("limits explicit source mappings", () => {
    const body = JSON.stringify({
      template: emptyTemplate,
      sourceFileMappings: { "one.ts": "OneFunction", "two.ts": "TwoFunction" }
    });

    expectPayloadTooLarge(
      () => analyzeCloudFormationBody(body, undefined, limits({ maxSourceMappings: 1 })),
      "Source mapping count"
    );
  });
});

describe("structured operation logging", () => {
  it("records safe metrics without serializing uploaded contents", () => {
    const entries: ApiOperationLogEntry[] = [];
    const sourceMarker = "private-source-marker";
    const rawBody = analysisEnvelope({ "handler.ts": sourceMarker });

    executeLoggedOperation({
      operation: "/analyze",
      requestId: "request-123",
      rawBody,
      execute: () => analyzeCloudFormationBody(rawBody),
      now: sequenceClock(100, 112),
      writeLog: (entry) => entries.push(entry)
    });

    expect(entries).to.deep.equal([
      {
        event: "api_operation",
        operation: "/analyze",
        requestId: "request-123",
        outcome: "success",
        durationMs: 12,
        sourceFileCount: 1,
        resourceCount: 0,
        findingCount: 0
      }
    ]);
    expect(JSON.stringify(entries)).not.to.contain(sourceMarker);
    expect(JSON.stringify(entries)).not.to.contain(emptyTemplate);
  });
});

function limits(overrides: Partial<ApiRequestLimits> = {}): ApiRequestLimits {
  return {
    maxRequestBytes: 10_000,
    maxTemplateBytes: 1_000,
    maxSourceFiles: 10,
    maxSourceFileBytes: 1_000,
    maxCombinedSourceBytes: 2_000,
    maxSourceMappings: 10,
    maxSourceExclusions: 10,
    maxDiffTemplateBytes: 2_000,
    maxFixes: 10,
    ...overrides
  };
}

function analysisEnvelope(sourceFiles: Record<string, string>): string {
  return JSON.stringify({ template: emptyTemplate, sourceFiles });
}

function expectPayloadTooLarge(execute: () => unknown, messagePart: string): void {
  try {
    execute();
    expect.fail("Expected request to be rejected.");
  } catch (error) {
    expect(error).to.be.instanceOf(ApiRequestError);
    expect(error).to.include({ statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
    expect((error as Error).message).to.contain(messagePart);
  }
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
