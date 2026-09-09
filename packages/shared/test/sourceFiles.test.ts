import { expect } from "chai";
import { normalizeSourceFilePath, normalizeSourceAnalysisInput, SourcePathError } from "../src";

describe("project-relative source identity", () => {
  it("normalizes separators and dot segments without flattening or folding case", () => {
    expect(normalizeSourceFilePath(".\\src\\orders//services/../Handler.ts")).to.equal("src/orders/Handler.ts");
    expect(normalizeSourceFilePath("src/payments/Handler.ts")).to.equal("src/payments/Handler.ts");
  });

  for (const path of ["", ".", "../secret.ts", "src/../../secret.ts", "/home/me/handler.ts",
    "C:\\Users\\me\\handler.ts", "C:handler.ts", "\\\\server\\share\\handler.ts", "file:///private.ts",
    "src/handler\u0000.ts", "src/handler\n.ts", "src/"]) {
    it(`rejects unsafe or empty path ${JSON.stringify(path)} without echoing it`, () => {
      expect(() => normalizeSourceFilePath(path)).to.throw(SourcePathError);
      try { normalizeSourceFilePath(path); } catch (error) {
        if (path.length > 3) expect((error as Error).message).not.to.contain(path);
      }
    });
  }

  it("normalizes files, explicit mappings and shared exclusions with the same rules", () => {
    const source = { sourceFiles: { "src\\orders\\handler.ts": "orders", "src/payments/handler.ts": "payments" },
      sourceFileMappings: { "./src/orders/handler.ts": "OrdersFunction" },
      sourceFileExclusions: ["src\\payments\\handler.ts"] };
    const before = structuredClone(source);
    expect(normalizeSourceAnalysisInput(source)).to.deep.equal({
      sourceFiles: { "src/orders/handler.ts": "orders", "src/payments/handler.ts": "payments" },
      sourceFileMappings: { "src/orders/handler.ts": "OrdersFunction" },
      sourceFileExclusions: ["src/payments/handler.ts"]
    });
    expect(source).to.deep.equal(before);
  });

  it("rejects normalized collisions instead of silently dropping entries", () => {
    const collision = { "src\\handler.ts": "first", "./src/handler.ts": "second" };
    expect(() => normalizeSourceAnalysisInput({ sourceFiles: collision })).to.throw("duplicate normalized paths");
    expect(() => normalizeSourceAnalysisInput({ sourceFileMappings: collision })).to.throw("duplicate normalized paths");
    expect(() => normalizeSourceAnalysisInput({ sourceFileExclusions: Object.keys(collision) })).to.throw("duplicate normalized paths");
  });

  it("preserves case-sensitive identities and special object keys as data", () => {
    const files = Object.fromEntries([["src/A.ts", "one"], ["src/a.ts", "two"], ["__proto__", "three"]]);
    expect(Object.entries(normalizeSourceAnalysisInput({ sourceFiles: files }).sourceFiles!)).to.deep.equal(Object.entries(files));
  });
});
