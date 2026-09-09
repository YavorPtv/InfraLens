import { expect } from "chai";
import type { CfnTemplate } from "@infralens/shared";
import { inferIamActionsFromSourceCode } from "../src";

const put = 'import { PutCommand } from "@aws-sdk/lib-dynamodb"; new PutCommand({});';
const get = 'import { GetCommand } from "@aws-sdk/lib-dynamodb"; new GetCommand({});';
const template: CfnTemplate = { Resources: {
  OrdersFunction: { Type: "AWS::Lambda::Function", Properties: { Handler: "src/orders/handler.handler" } },
  AdminFunction: { Type: "AWS::Lambda::Function", Properties: { Handler: "src/admin/handler.handler" } }
} };

describe("source project paths in analyzer inference", () => {
  it("normalizes direct caller paths and resolves same-named helpers against their own directories", () => {
    const files = {
      "src\\orders\\handler.ts": 'import "./utils";', "src\\orders\\utils.ts": put,
      "src/admin/handler.ts": 'import "./utils";', "src/admin/utils.ts": get
    };
    const result = inferIamActionsFromSourceCode(files, { template,
      sourceFileMappings: { "./src/orders/handler.ts": "OrdersFunction", "src\\admin\\handler.ts": "AdminFunction" }
    });
    expect(result.map((action) => [action.lambdaFunctionId, action.filePath, action.action])).to.have.deep.members([
      ["OrdersFunction", "src/orders/utils.ts", "dynamodb:PutItem"],
      ["AdminFunction", "src/admin/utils.ts", "dynamodb:GetItem"]
    ]);
    expect(result.every((action) => action.confidence === "high")).to.equal(true);
    expect(result[0].evidence).to.equal("sourceFileMappings.src/orders/handler.ts");
  });

  it("matches full handler paths without mixing duplicate basenames or raising confidence", () => {
    const result = inferIamActionsFromSourceCode({ "src/orders/handler.ts": put, "src/admin/handler.ts": get }, { template });
    expect(result.map((action) => [action.lambdaFunctionId, action.confidence])).to.deep.equal([
      ["OrdersFunction", "medium"], ["AdminFunction", "medium"]
    ]);
  });

  it("leaves ambiguous basename-only handlers unresolved even with one Lambda", () => {
    const result = inferIamActionsFromSourceCode({ "src/orders/handler.ts": put, "src/admin/handler.ts": get }, {
      template: { Resources: { HandlerFunction: { Type: "AWS::Lambda::Function", Properties: { Handler: "handler.handler" } } } }
    });
    expect(result).to.have.length(2);
    expect(result.every((action) => action.lambdaFunctionId === undefined && action.confidence === "low")).to.equal(true);
  });

  it("does not use a basename match to override a conflicting known directory", () => {
    const result = inferIamActionsFromSourceCode({ "src/other/handler.ts": put }, { template });
    expect(result[0].lambdaFunctionId).to.equal(undefined);
  });

  it("ignores relative imports escaping the project instead of aliasing an uploaded file", () => {
    const result = inferIamActionsFromSourceCode({ "src/orders/handler.ts": 'import "../../../secret";', "secret.ts": put }, { template });
    expect(result).to.have.length(1);
    expect(result[0].filePath).to.equal("secret.ts");
    expect(result[0].lambdaFunctionId).to.equal(undefined);
  });

  it("rejects unsafe and colliding identities for direct analyzer callers", () => {
    expect(() => inferIamActionsFromSourceCode({ "/private/file.ts": put }, { template })).to.throw("relative project paths");
    expect(() => inferIamActionsFromSourceCode({ "src\\a.ts": put, "src/a.ts": get }, { template })).to.throw("duplicate normalized paths");
  });

  it("resolves nested index modules and ignores ambiguous extension matches", () => {
    const result = inferIamActionsFromSourceCode({
      "src/orders/handler.ts": 'import "./helpers"; import "./helpers/"; import "./ambiguous";',
      "src/orders/helpers/index.tsx": put,
      "src/orders/ambiguous.ts": get,
      "src/orders/ambiguous.js": get
    }, { template });
    const associated = result.filter((action) => action.lambdaFunctionId === "OrdersFunction");
    expect(associated).to.have.length(1);
    expect(associated[0].filePath).to.equal("src/orders/helpers/index.tsx");
  });
});
