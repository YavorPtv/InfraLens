import { expect } from "chai";
import type { AnalysisReport, ApplySuggestionsResult } from "@infralens/shared";
import { example, localApi } from "./workflowFixtures";

describe("partial IAM and partitioned S3 API workflow", () => {
  const post = localApi();
  it("returns explainable IAM limitations and applies split statements through the offline API", async () => {
    const template = example("analyzer-coverage/template.json");
    const sourceFiles = Object.fromEntries(["files.ts", "fileService.ts", "sharedStorage.ts", "notAws.ts"].map(path => [path, example(`analyzer-coverage/${path}`)]));
    const report = await post<AnalysisReport>("/analyze", { template, sourceFiles, sourceFileMappings: { "files.ts": "FilesFunction" }, sourceFileExclusions: ["fileService.ts", "sharedStorage.ts", "notAws.ts"] });
    expect(report.iamAnalysis?.evaluation).to.equal("partial");
    expect(report.iamAnalysis?.limitations.join(" ")).to.include("unresolved external managed policy");
    const conditional = report.findings.find(value => value.resourceId === "ConditionRole")!;
    expect(conditional.iamContext?.condition.status).to.equal("understood");
    const suggestion = report.leastPrivilegeSuggestions.find(value => value.roleId === "FilesRole")!;
    expect(suggestion.suggestedStatements).to.have.lengthOf(2);
    const fix = report.templateFixes!.find(value => value.source.kind === "least-privilege" && value.targetResourceId === "FilesRole")!;
    const applied = await post<ApplySuggestionsResult>("/apply", { template, fixes: [fix] });
    expect(applied.appliedFixCount).to.equal(1);
    const reanalyzed = await post<AnalysisReport>("/analyze", { template: JSON.stringify(applied.modifiedTemplate), sourceFiles });
    expect(reanalyzed.findings.filter(value => value.resourceId === "FilesRole" && value.ruleId === "IAM_WILDCARD_PERMISSIONS")).to.deep.equal([]);
  });
});
