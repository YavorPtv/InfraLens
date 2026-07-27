import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";
import { analyzeTemplate, analyzeTemplateDiff } from "../src";

describe("example CloudFormation fixtures", () => {
  const fixtureNames = ["simple-good-template.json", "simple-bad-template.json"];

  for (const fixtureName of fixtureNames) {
    it(`parses ${fixtureName} as JSON with resources`, () => {
      const fixturePath = resolve("../../examples", fixtureName);
      const template = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        Resources?: unknown;
      };

      expect(template.Resources).to.be.an("object");
    });
  }

  it("does not report findings for the good example", () => {
    const fixturePath = resolve("../../examples", "simple-good-template.json");
    const report = analyzeTemplate(readFileSync(fixturePath, "utf8"));

    expect(report.findings).to.deep.equal([]);
    expect(report.score).to.equal(100);
  });

  it("reports expected findings for the bad example", () => {
    const fixturePath = resolve("../../examples", "simple-bad-template.json");
    const report = analyzeTemplate(readFileSync(fixturePath, "utf8"));

    expect(report.summary.totalFindings).to.equal(4);
    expect(report.score).to.equal(40);
  });

  it("analyzes the YAML example template", () => {
    const fixturePath = resolve("../../examples", "simple-yaml-template.yaml");
    const report = analyzeTemplate(readFileSync(fixturePath, "utf8"));

    expect(report.resources.map((resource) => resource.id)).to.include.members([
      "OrdersTable",
      "OrderHandler",
      "OrderHandlerRole"
    ]);
    expect(report.edges).to.deep.include({
      from: "OrderHandler",
      to: "OrderHandlerRole",
      relationship: "uses-role",
      evidencePath: "Resources.OrderHandler.Properties.Role.Fn::GetAtt"
    });
  });

  it("documents expected compare fixture diff results", () => {
    const diff = analyzeTemplateDiff(
      readExampleFixture("compare/old-order-service-template.json"),
      readExampleFixture("compare/new-order-service-template.json")
    );

    expect(diff.resources.added.map((resource) => resource.id)).to.deep.equal([
      "OrderDeadLetterQueue",
      "OrdersApi",
      "OrdersResource",
      "PublicOrdersMethod",
      "ReportRole",
      "UploadBucket"
    ]);
    expect(diff.resources.removed.map((resource) => resource.id)).to.deep.equal([
      "LegacyTopic"
    ]);
    expect(diff.resources.changed.map((resource) => resource.resourceId)).to.deep.equal([
      "OrdersTable",
      "OrderQueue",
      "OrderLogGroup"
    ]);

    expect(diff.findings.introduced.map(toFindingLabel)).to.have.members([
      "IAM_WILDCARD_PERMISSIONS:ReportRole",
      "S3_PUBLIC_ACCESS_BLOCK_MISSING:UploadBucket",
      "API_GATEWAY_METHOD_NO_AUTH:PublicOrdersMethod"
    ]);
    expect(diff.findings.resolved.map(toFindingLabel)).to.have.members([
      "DYNAMODB_MISSING_PITR:OrdersTable",
      "SQS_MISSING_DLQ:OrderQueue",
      "LOG_GROUP_MISSING_RETENTION:OrderLogGroup"
    ]);
  });
});

function readExampleFixture(fixtureName: string): string {
  return readFileSync(resolve("../../examples", fixtureName), "utf8");
}

function toFindingLabel(finding: { ruleId: string; resourceId: string }): string {
  return `${finding.ruleId}:${finding.resourceId}`;
}
