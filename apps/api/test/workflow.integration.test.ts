import { expect } from "chai";
import { applyTemplateFixes, parseTemplateInput } from "@infralens/analyzer";
import {
  exportAnalysisReportToJson, exportAnalysisReportToMarkdown, exportDiffReportToMarkdown,
  type AnalysisReport, type ApplySuggestionsResult, type DiffReport, type Finding
} from "@infralens/shared";
import { example, localApi } from "./workflowFixtures";

const findingKey = (finding: Finding) =>
  `${finding.ruleId}:${finding.resourceId}:${finding.evidencePath}`;

describe("Analyze -> Review -> Apply -> Compare -> Export integration", () => {
  const post = localApi();

  it("applies only selected fixes and carries accurate findings through generated-template comparison and exports", async () => {
    const template = example("order-service-risky-template.json");
    const original = parseTemplateInput(template);
    const before = structuredClone(original);
    const privateMarker = "UPLOADED_SOURCE_BODY_MUST_NOT_BE_EXPORTED";
    const source = `${example("shared-source-import-graph/sharedDb.ts")}\n// ${privateMarker}`;
    const report = await post<AnalysisReport>("/analyze", {
      template, sourceFiles: { "createOrder.ts": source },
      sourceFileMappings: { "createOrder.ts": "OrderHandler" }
    });
    expect(report.findings.map((f) => f.ruleId)).to.include.members([
      "IAM_WILDCARD_PERMISSIONS", "DYNAMODB_MISSING_PITR", "SQS_MISSING_DLQ",
      "LOG_GROUP_MISSING_RETENTION", "DYNAMODB_DELETION_PROTECTION_DISABLED", "LAMBDA_TRACING_DISABLED"
    ]);
    for (const finding of report.findings) {
      for (const field of ["ruleId", "title", "severity", "resourceId", "explanation", "evidencePath", "suggestion"] as const) {
        expect(finding[field]).to.be.a("string").and.not.equal("");
      }
    }
    const fixes = report.templateFixes ?? [];
    const selected = fixes.filter((fix) => fix.applicability === "applicable" && (
      fix.source.kind === "least-privilege" || fix.source.ruleId === "DYNAMODB_MISSING_PITR"
    ));
    expect(selected).to.have.length(2);
    expect(fixes.some((fix) => fix.applicability === "applicable" && !selected.includes(fix))).to.equal(true);
    expect(selected.every((fix) => fix.patches.length > 0)).to.equal(true);
    const suggestion = report.leastPrivilegeSuggestions.find((s) => s.roleId === "OrderHandlerRole")!;
    expect(suggestion.suggestedActions).to.deep.equal(["dynamodb:PutItem"]);
    expect(suggestion.suggestedResources.map((r) => r.suggestedResource)).to.deep.equal([
      { "Fn::GetAtt": ["OrdersTable", "Arn"] }
    ]);

    // Exercise object immutability at the production apply boundary as well as HTTP serialization.
    const direct = applyTemplateFixes(original, selected);
    expect(original).to.deep.equal(before);
    const applied = await post<ApplySuggestionsResult>("/apply", { template, fixes: selected });
    expect(applied).to.deep.equal(direct);
    expect(applied).to.include({ appliedFixCount: 2, failedFixCount: 0 });
    expect(applied.results.map((r) => r.fixId)).to.have.members(selected.map((f) => f.id));
    expect(applied.results.every((r) => r.status === "applied")).to.equal(true);

    // Build only the expected edits, preserving every other property, resource and intrinsic.
    const expected = structuredClone(before);
    expected.Resources.OrdersTable.Properties!.PointInTimeRecoverySpecification = { PointInTimeRecoveryEnabled: true };
    const policies = expected.Resources.OrderHandlerRole.Properties!.Policies as Array<{
      PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> }
    }>;
    policies[0].PolicyDocument.Statement[0].Action = "dynamodb:PutItem";
    policies[0].PolicyDocument.Statement[0].Resource = { "Fn::GetAtt": ["OrdersTable", "Arn"] };
    expect(applied.modifiedTemplate).to.deep.equal(expected);
    const generated = JSON.stringify(applied.modifiedTemplate);
    const improved = await post<AnalysisReport>("/analyze", generated);
    const diff = await post<DiffReport>("/diff", { oldTemplate: template, newTemplate: generated });
    expect(diff.resources.changed.map((r) => r.resourceId)).to.have.members(["OrdersTable", "OrderHandlerRole"]);
    expect(diff.resources.added).to.deep.equal([]);
    expect(diff.resources.removed).to.deep.equal([]);
    expect(diff.findings.introduced).to.deep.equal([]);
    const resolved = report.findings.filter((f) =>
      f.ruleId === "DYNAMODB_MISSING_PITR" ||
      (f.ruleId === "IAM_WILDCARD_PERMISSIONS" && f.evidencePath.endsWith("Statement[0]"))
    );
    expect(resolved).to.have.length(2);
    expect(diff.findings.resolved.map(findingKey)).to.have.members(resolved.map(findingKey));
    expect(diff.findings.unchanged.map(findingKey)).to.have.members(
      report.findings.filter((f) => !resolved.includes(f)).map(findingKey)
    );
    expect(diff.newReport.findings).to.deep.equal(improved.findings);
    expect(improved.findings.map((f) => f.ruleId)).to.include.members([
      "SQS_MISSING_DLQ", "LOG_GROUP_MISSING_RETENTION", "DYNAMODB_DELETION_PROTECTION_DISABLED"
    ]);

    const json = exportAnalysisReportToJson(report);
    const markdown = exportAnalysisReportToMarkdown(report);
    const diffMarkdown = exportDiffReportToMarkdown(diff);
    // Diff JSON uses JSON.stringify in the CLI; there is no separate shared JSON diff exporter.
    const diffJson = JSON.stringify(diff, null, 2);
    expect(JSON.parse(json).findings).to.deep.equal(report.findings);
    expect(JSON.parse(json).leastPrivilegeSuggestions).to.deep.equal(report.leastPrivilegeSuggestions);
    expect(JSON.parse(diffJson).findings).to.deep.equal(diff.findings);
    for (const section of ["## Score", "## Findings", "## Severity Summary", "## Least-Privilege Suggestions"]) {
      expect(markdown).to.contain(section);
    }
    for (const section of ["### Changed Resources", "### Resolved Findings", "### Unchanged Findings", "## Least-Privilege Suggestions"]) {
      expect(diffMarkdown).to.contain(section);
    }
    for (const finding of report.findings) {
      expect(markdown).to.contain(finding.ruleId).and.contain(finding.evidencePath);
      expect(diffMarkdown).to.contain(finding.ruleId).and.contain(finding.evidencePath);
    }
    expect(markdown).to.contain("dynamodb:PutItem").and.contain("createOrder.ts").and.contain("PutCommand");
    expect(diffMarkdown).to.contain("OrderHandlerRole").and.contain("OrdersTable");
    for (const output of [json, markdown, diffMarkdown, diffJson]) {
      expect(output).to.not.contain(privateMarker);
      expect(output).to.not.contain("const dynamodbClient");
    }
  });
});
