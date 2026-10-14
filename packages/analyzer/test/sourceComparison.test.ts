import { expect } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DiffApiRequest } from "@infralens/shared";
import { analyzeTemplateDiff } from "../src";

const fixture: DiffApiRequest = JSON.parse(readFileSync(resolve(__dirname, "../../../examples/compare/source-action-change.json"), "utf8"));
const compare = (oldSource = fixture.oldSource, newSource = fixture.newSource) =>
  analyzeTemplateDiff(fixture.oldTemplate, fixture.newTemplate, { oldTemplate: oldSource, newTemplate: newSource });

describe("source-aware comparison", () => {
  it("explains a code-only read-to-write change with Lambda, resource and policy evidence", () => {
    const diff = compare();
    expect(diff.resources).to.deep.equal({ added: [], removed: [], changed: [] });
    expect(diff.findings.introduced).to.deep.equal([]);
    expect(diff.findings.resolved).to.deep.equal([]);
    expect(diff.source!.added[0]).to.include({ action: "dynamodb:PutItem", lambdaFunctionId: "AppFunction", confidence: "high" });
    expect(diff.source!.added[0].useLocation).to.have.keys("line", "column");
    expect(diff.source!.noLongerObserved.map(action => action.action)).to.deep.equal(["dynamodb:GetItem"]);
    const changed = diff.suggestions!.changed[0];
    expect(changed.old.suggestedActions).to.deep.equal(["dynamodb:GetItem"]);
    expect(changed.new.suggestedActions).to.deep.equal(["dynamodb:PutItem"]);
    expect(changed.new.suggestedResources[0].resourceId).to.equal("OrdersTable");
    expect(changed.new.evidence.statementEvidencePath).to.contain("AppRole");
    expect(diff.source!.warnings.join(" ")).to.include("not actual IAM permissions");
  });

  it("keeps unchanged inputs stable and treats missing and empty source differently", () => {
    const unchanged = compare(fixture.oldSource, fixture.oldSource);
    expect(unchanged.source!.added).to.deep.equal([]);
    expect(unchanged.source!.noLongerObserved).to.deep.equal([]);
    expect(unchanged.source!.changed).to.deep.equal([]);
    expect(unchanged.suggestions!.changed).to.deep.equal([]);
    expect(unchanged.source!.unchanged).to.have.length(1);
    const missing = analyzeTemplateDiff(fixture.oldTemplate, fixture.newTemplate, { newTemplate: { sourceFiles: {} } });
    expect(missing.source!.old.status).to.equal("missing");
    expect(missing.source!.new.status).to.equal("provided");
    expect(missing.source!.new.fileCount).to.equal(0);
    expect(missing.source!.warnings.join(" ")).to.include("cannot establish source equivalence");
  });

  it("keeps mappings and exclusions independent, including unresolved attribution", () => {
    const diff = analyzeTemplateDiff(fixture.oldTemplate, '{"Resources":{}}', {
      oldTemplate: fixture.oldSource, newTemplate: { sourceFiles: fixture.newSource!.sourceFiles }
    });
    expect(diff.source!.old.actions[0].lambdaFunctionId).to.equal("AppFunction");
    expect(diff.source!.new.actions[0].lambdaFunctionId).to.equal(undefined);
    expect(diff.source!.warnings.join(" ")).to.include("manual review");
    const excluded = compare(fixture.oldSource, { ...fixture.newSource, sourceFileExclusions: ["src/handler.ts"] });
    expect(excluded.source!.old.actions).to.have.length(1);
    expect(excluded.source!.new.actions).to.deep.equal([]);
    expect(excluded.source!.warnings.join(" ")).to.include("not proof");
  });

  it("attributes the same file to independent explicit Lambda mappings", () => {
    const template = JSON.parse(fixture.oldTemplate);
    template.Resources.OtherFunction = structuredClone(template.Resources.AppFunction);
    const input = JSON.stringify(template);
    const diff = analyzeTemplateDiff(input, input, { oldTemplate: fixture.oldSource,
      newTemplate: { ...fixture.oldSource, sourceFileMappings: { "src/handler.ts": "OtherFunction" } } });
    expect(diff.source!.noLongerObserved[0].lambdaFunctionId).to.equal("AppFunction");
    expect(diff.source!.added[0].lambdaFunctionId).to.equal("OtherFunction");
  });

  it("reports changed confidence/evidence and unresolved imports even if an action is unchanged", () => {
    const source = structuredClone(fixture.oldSource!);
    source.sourceFiles!["src/handler.ts"] += "\nimport './missing';";
    const diff = compare(fixture.oldSource, source);
    expect(diff.source!.changed).to.have.length(1);
    expect(diff.source!.changed[0].new.actionConfidence).to.equal("low");
    expect(diff.source!.warnings.join(" ")).to.include("missing");
    expect(diff.suggestions!.changed[0].new.manualOnly).to.equal(true);
  });
});
