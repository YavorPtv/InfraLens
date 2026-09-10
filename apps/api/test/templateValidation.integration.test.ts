import { expect } from "chai";
import { analyzeTemplate, applyTemplateFixes } from "@infralens/analyzer";
import { canDownloadGeneratedTemplate, exportAnalysisReportToMarkdown, type AnalysisReport, type ApplySuggestionsResult, type DiffReport, type TemplateValidationResult } from "@infralens/shared";
import { createAnalyzeLambdaHandler } from "../src/lambda";
import { createCloudFormationValidator, type CloudFormationTemplateValidator } from "../src/cloudFormationValidation";
import type { ApiErrorResponse } from "../src";
import { localApi } from "./workflowFixtures";

const template = '{"Resources":{"Bucket":{"Type":"AWS::S3::Bucket"}}}';

for (const status of ["valid", "invalid", "unavailable"] as const) {
  describe(`validation transport parity: AWS ${status}`, () => {
    const validator: CloudFormationTemplateValidator = createCloudFormationValidator(async () => {
      if (status === "invalid") throw Object.assign(new Error("private AWS details"), { name: "ValidationError" });
      if (status === "unavailable") throw new Error("private network details");
      return {};
    });
    const post = localApi({ cloudFormationValidator: validator });
    const handler = createAnalyzeLambdaHandler({ cloudFormationValidator: validator, writeLog: () => {} });
    it("keeps completed analysis independent of AWS results in both transports and exports", async () => {
      const report = await post<AnalysisReport>("/analyze", template);
      const response = await handler({ httpMethod: "POST", path: "/analyze", body: template });
      expect(response.statusCode).to.equal(200);
      expect(JSON.parse(response.body)).to.deep.equal(report);
      expect(report.analysisStatus).to.equal("completed");
      expect(report.findings.length).to.be.greaterThan(0);
      expect(report.validation).to.include({ parse: "valid", structure: "valid", cloudFormation: status });
      expect(exportAnalysisReportToMarkdown(report)).to.contain(`AWS CloudFormation validation: ${status}`);
      expect(JSON.stringify(report)).not.to.contain("private");
    });
    it("validates original and generated templates before allowing download and still supports compare", async () => {
      const fixes = analyzeTemplate(template).templateFixes!.filter(f => f.applicability === "applicable");
      const body = JSON.stringify({ template, fixes });
      const result = await post<ApplySuggestionsResult>("/apply", body);
      const response = await handler({ httpMethod: "POST", path: "/apply", body });
      expect(response.statusCode).to.equal(200);
      expect(JSON.parse(response.body)).to.deep.equal(result);
      expect(result.originalValidation.cloudFormation).to.equal(status);
      expect(result.validation.cloudFormation).to.equal(status);
      expect(result.generatedTemplateStatus).to.equal(status === "valid" ? "ready" : status === "invalid" ? "invalid" : "review-required");
      expect(canDownloadGeneratedTemplate(result.validation)).to.equal(status !== "invalid");
      expect(result.modifiedTemplate.Resources.Bucket.Properties).to.have.property("PublicAccessBlockConfiguration");
      if (status === "invalid") expect(result.validation.issues[0].relatedFixIds).to.have.members(fixes.map(f => f.id));
      if (status === "valid") {
        const diff = await post<DiffReport>("/diff", { oldTemplate: template, newTemplate: JSON.stringify(result.modifiedTemplate) });
        expect(diff.findings.resolved).to.have.length(2);
        expect(diff.newReport.validation.structure).to.equal("valid");
      }
    });
  });
}

describe("validation stage failures", () => {
  const post = localApi();
  const handler = createAnalyzeLambdaHandler({ writeLog: () => {} });
  for (const [body, stage] of [["{", "parse"], ['{"Resources":{"Broken":{}}}', "structure"]] as const) {
    it(`returns ${stage} failure and analyzer not-run consistently`, async () => {
      const payload = await post<ApiErrorResponse>("/analyze", body, 400);
      const response = await handler({ httpMethod: "POST", path: "/analyze", body });
      expect(response.statusCode).to.equal(400);
      expect(JSON.parse(response.body)).to.deep.equal(payload);
      expect(payload.error.analysisStatus).to.equal("not-run");
      expect(payload.error.validation![stage]).to.equal("invalid");
      expect(payload.error.validation!.cloudFormation).to.equal("not-run");
    });
  }
});

describe("generated artifact regression at the API boundary", () => {
  const apply: typeof applyTemplateFixes = (original, fixes) => {
    const result = applyTemplateFixes(original, fixes);
    // Simulate a patch engine regression after its own checks passed.
    delete (result.modifiedTemplate.Resources.Bucket as { Type?: string }).Type;
    return result;
  };
  const validator = createCloudFormationValidator(async () => ({}));
  const post = localApi({ apply, cloudFormationValidator: validator });
  const handler = createAnalyzeLambdaHandler({ apply, cloudFormationValidator: validator, writeLog: () => {} });
  it("rechecks the actual artifact, blocks readiness and keeps the malformed output inspectable", async () => {
    const fixes = analyzeTemplate(template).templateFixes!.filter(f => f.applicability === "applicable");
    const body = JSON.stringify({ template, fixes });
    const result = await post<ApplySuggestionsResult>("/apply", body);
    const response = await handler({ httpMethod: "POST", path: "/apply", body });
    expect(response.statusCode).to.equal(200);
    expect(JSON.parse(response.body)).to.deep.equal(result);
    expect(result.originalValidation.structure).to.equal("valid");
    expect(result.validation).to.include({ parse: "valid", structure: "invalid", cloudFormation: "not-run" });
    expect(result.generatedTemplateStatus).to.equal("invalid");
    expect(canDownloadGeneratedTemplate(result.validation)).to.equal(false);
    expect(result.modifiedTemplate.Resources.Bucket).not.to.have.property("Type");
    expect(result.validation.issues[0].relatedFixIds).to.have.members(fixes.map(f => f.id));
  });
});

describe("analyzer internal error stage", () => {
  const analyze = () => { throw new Error("internal secret"); };
  const post = localApi({ analyze });
  const handler = createAnalyzeLambdaHandler({ analyze, writeLog: () => {} });
  it("retains successful local validation without exposing internals", async () => {
    const result = await post<ApiErrorResponse>("/analyze", template, 500);
    const response = await handler({ httpMethod: "POST", path: "/analyze", body: template });
    expect(JSON.parse(response.body)).to.deep.equal(result);
    expect(result.error).to.include({ code: "ANALYZER_INTERNAL_ERROR", analysisStatus: "failed" });
    expect(result.error.validation).to.deep.equal({ parse: "valid", structure: "valid", cloudFormation: "not-run", issues: [] } satisfies TemplateValidationResult);
    expect(JSON.stringify(result)).not.to.contain("internal secret");
  });
});
