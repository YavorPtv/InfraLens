import { expect } from "chai";
import { defaultApiRequestLimits, type ApiErrorResponse } from "../src";
import { createAnalyzeLambdaHandler } from "../src/lambda";
import { localApi } from "./workflowFixtures";

const template = '{"Resources":{}}';

describe("source path validation through both API adapters", () => {
  const post = localApi();
  const handler = createAnalyzeLambdaHandler({ writeLog: () => {} });
  for (const input of [
    { sourceFiles: { "../outside.ts": "source" } },
    { sourceFiles: { "C:\\private\\handler.ts": "source" } },
    { sourceFiles: { "/home/private/handler.ts": "source" } },
    { sourceFiles: { "src\\handler.ts": "one", "./src/handler.ts": "two" } },
    { sourceFileMappings: { "../outside.ts": "OrdersFunction" } },
    { sourceFileMappings: { "src\\handler.ts": "OrdersFunction", "src/handler.ts": "OtherFunction" } },
    { sourceFileExclusions: ["/private/handler.ts"] },
    { sourceFileExclusions: ["src/handler.ts", "src\\handler.ts"] }
  ]) {
    it(`rejects invalid or colliding ${Object.keys(input)[0]} paths (${JSON.stringify(input)})`, async () => {
      const body = JSON.stringify({ template, ...input });
      const http = await post<ApiErrorResponse>("/analyze", body, 400);
      const lambda = await handler({ httpMethod: "POST", path: "/analyze", body });
      expect(lambda.statusCode).to.equal(400);
      expect(JSON.parse(lambda.body)).to.deep.equal(http);
      expect(http.error.code).to.equal("INVALID_TEMPLATE");
      expect(JSON.stringify(http)).not.to.contain("private");
    });
  }
});

describe("nested source paths retain hosted size and count protections", () => {
  const limits = { ...defaultApiRequestLimits, maxRequestBytes: 2048,
    maxSourceFiles: 2, maxSourceFileBytes: 8, maxCombinedSourceBytes: 12 };
  const post = localApi({ requestLimits: limits });
  const handler = createAnalyzeLambdaHandler({ requestLimits: limits, writeLog: () => {} });
  for (const scenario of [
    { name: "file count", input: { sourceFiles: { "src/a/util.ts": "", "src/b/util.ts": "", "src/c/util.ts": "" } } },
    { name: "single file bytes", input: { sourceFiles: { "src/nested/util.ts": "123456789" } } },
    { name: "combined source bytes", input: { sourceFiles: { "src/a/util.ts": "1234567", "src/b/util.ts": "123456" } } },
    { name: "request bytes including paths", input: { sourceFiles: { [`src/${"a".repeat(2048)}.ts`]: "" } } }
  ]) {
    it(`enforces ${scenario.name}`, async () => {
      const body = JSON.stringify({ template, ...scenario.input });
      const http = await post<ApiErrorResponse>("/analyze", body, 413);
      const lambda = await handler({ httpMethod: "POST", path: "/analyze", body });
      expect(lambda.statusCode).to.equal(413);
      expect(http.error.code).to.equal("PAYLOAD_TOO_LARGE");
      expect(JSON.parse(lambda.body).error.code).to.equal("PAYLOAD_TOO_LARGE");
    });
  }

  it("accepts distinct nested basenames at the source count and combined-byte limits", async () => {
    const body = JSON.stringify({ template, sourceFiles: { "src/a/util.ts": "123456", "src/b/util.ts": "123456" } });
    await post("/analyze", body);
    expect((await handler({ httpMethod: "POST", path: "/analyze", body })).statusCode).to.equal(200);
  });
});
