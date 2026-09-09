import { expect } from "chai";
import {
  autoDetectMappingValue, manualMappingValue, sharedSourceMappingValue,
  mergeSourceFiles, readSourceUploads, removeSourceFile, toSourceFileMap,
  toSourceFileMappings, toSourceFileExclusions
} from "../../web/src/sourceFiles";
import { serializeAnalyzeRequest } from "../../web/src/api/analyzeRequest";

describe("web source upload transformation (without a browser)", () => {
  it("prefers webkitRelativePath and keeps only the name when that is all the browser provides", async () => {
    const result = await readSourceUploads([
      { name: "handler.ts", webkitRelativePath: "project\\src\\orders\\handler.ts", text: async () => "orders" },
      { name: "handler.ts", webkitRelativePath: "", text: async () => "single" }
    ]);
    expect(result.files).to.deep.equal([
      { path: "project/src/orders/handler.ts", content: "orders" },
      { path: "handler.ts", content: "single" }
    ]);
  });

  it("replaces the exact path visibly while preserving its mapping and a duplicate basename", () => {
    const initial = mergeSourceFiles([], [{ path: "src/orders/handler.ts", content: "old" }]);
    initial[0].mappingSelection = manualMappingValue;
    initial[0].manualLambdaFunctionId = "OrdersFunction";
    const both = mergeSourceFiles(initial, [{ path: "src/admin/handler.ts", content: "admin" }]);
    both[1].mappingSelection = "AdminFunction";
    const before = structuredClone(both);
    const replaced = mergeSourceFiles(both, [{ path: "src\\orders\\handler.ts", content: "new" }]);
    expect(replaced).to.have.length(2);
    expect(replaced[0]).to.include({ path: "src/orders/handler.ts", content: "new", uploadStatus: "replaced",
      mappingSelection: manualMappingValue, manualLambdaFunctionId: "OrdersFunction" });
    expect(replaced[1]).to.deep.equal(both[1]);
    expect(both).to.deep.equal(before);
    expect(toSourceFileMappings(replaced, ["OrdersFunction", "AdminFunction"])).to.deep.equal({
      "src/orders/handler.ts": "OrdersFunction", "src/admin/handler.ts": "AdminFunction"
    });
    const removed = removeSourceFile(replaced, "src/orders/handler.ts");
    expect(toSourceFileMap(removed)).to.deep.equal({ "src/admin/handler.ts": "admin" });
    expect(toSourceFileMappings(removed, ["AdminFunction"])).to.deep.equal({ "src/admin/handler.ts": "AdminFunction" });
    const readded = mergeSourceFiles(removed, [{ path: "src/orders/handler.ts", content: "again" }]);
    expect(readded[1]).to.include({ uploadStatus: "added", mappingSelection: autoDetectMappingValue });
    expect(readded[1].manualLambdaFunctionId).to.equal(undefined);
  });

  it("uses the last entry in a batch and never transfers mappings to a different path", () => {
    const files = mergeSourceFiles([], [
      { path: "src/handler.ts", content: "first" }, { path: "./src/handler.ts", content: "last" }
    ]);
    expect(files).to.have.length(1);
    expect(files[0]).to.include({ content: "last", uploadStatus: "replaced" });
    files[0].mappingSelection = sharedSourceMappingValue;
    const more = mergeSourceFiles(files, [{ path: "other/handler.ts", content: "other" }]);
    expect(more[1].mappingSelection).to.equal(autoDetectMappingValue);
    expect(toSourceFileExclusions(more, [])).to.deep.equal(["src/handler.ts"]);
    expect(toSourceFileExclusions(removeSourceFile(more, "src/handler.ts"), [])).to.equal(undefined);
  });

  it("filters folders before reading contents and supports all analyzer source extensions", async () => {
    const names = ["app/a.ts", "app/b.tsx", "app/c.js", "app/d.jsx", "app/e.mjs", "app/f.cjs"];
    const skipped = ["app/package.json", "app/node_modules/sdk/index.js", "app/.git/config.ts"];
    const result = await readSourceUploads([
      ...names.map((path) => ({ name: path.split("/").at(-1)!, webkitRelativePath: path, text: async () => "source" })),
      ...skipped.map((path) => ({ name: path.split("/").at(-1)!, webkitRelativePath: path,
        text: async () => { throw new Error("Skipped files must not be read"); } }))
    ], true);
    expect(result.files.map((f) => f.path)).to.deep.equal(names);
    expect(result.ignoredCount).to.equal(3);
  });

  it("rejects absolute browser paths without reading their contents", async () => {
    let read = false;
    try {
      await readSourceUploads([{ name: "handler.ts", webkitRelativePath: "C:\\private\\handler.ts", text: async () => { read = true; return "secret"; } }]);
      expect.fail("Expected unsafe path rejection");
    } catch (error) {
      expect((error as Error).message).to.contain("relative project paths").and.not.contain("private");
    }
    expect(read).to.equal(false);
  });

  it("propagates file-read failures without producing a partial upload", async () => {
    let result;
    try {
      result = await readSourceUploads([{ name: "a.ts", text: async () => "ok" },
        { name: "b.ts", text: async () => { throw new Error("Read failed"); } }]);
      expect.fail("Expected read rejection");
    } catch (error) { expect((error as Error).message).to.equal("Read failed"); }
    expect(result).to.equal(undefined);
  });

  it("keeps template-only request compatibility", () => {
    expect(serializeAnalyzeRequest({ templateInput: "Resources: {}" })).to.deep.equal({
      body: "Resources: {}", contentType: "text/plain; charset=utf-8"
    });
  });
});
