import { expect } from "chai";
import { analyzeTemplate, applyTemplateFixes, parseTemplateInput, validateTemplate, TemplateValidationError } from "../src";
import { canDownloadGeneratedTemplate, getGeneratedTemplateStatus, type TemplateFix } from "@infralens/shared";

const json = JSON.stringify({ Resources: { Bucket: { Type: "AWS::S3::Bucket" } } });

describe("layered local template validation", () => {
  for (const [name, text] of [["JSON", json], ["YAML", "Resources:\n  Bucket:\n    Type: AWS::S3::Bucket"]]) {
    it(`validates ${name} without AWS credentials`, () => {
      expect(validateTemplate(text).validation).to.deep.equal({ parse: "valid", structure: "valid", cloudFormation: "not-run", issues: [] });
      expect(analyzeTemplate(text).analysisStatus).to.equal("completed");
    });
  }
  for (const [name, text] of [["JSON", '{"Resources":'], ["YAML", "Resources:\n  Bucket: ["], ["empty input", ""]]) {
    it(`identifies invalid ${name} at the parse stage`, () => {
      const { validation } = validateTemplate(text);
      expect(validation).to.include({ parse: "invalid", structure: "not-run", cloudFormation: "not-run" });
      expect(validation.issues[0]).to.include({ code: "TEMPLATE_PARSE_ERROR", stage: "parse" });
      expect(() => analyzeTemplate(text)).to.throw(TemplateValidationError);
      expect(validation.issues[0].message).not.to.contain(" at parseTemplate");
    });
  }
  const shapes = [null, [], {}, { Resources: [] }, { Resources: { Broken: false } },
    { Resources: { Broken: {} } }, { Resources: { Broken: { Type: " " } } },
    { Resources: { Broken: { Type: "AWS::S3::Bucket", Properties: [] } } },
    { Resources: {}, Parameters: [] }, { Resources: {}, Parameters: { Name: {} } },
    { Resources: {}, Outputs: { Name: {} } }, { Resources: {}, Conditions: "bad" },
    { Resources: {}, Transform: [false] }, { Resources: {}, Description: 5 },
    { Resources: { Broken: { Type: "AWS::S3::Bucket", DependsOn: 42 } } }];
  shapes.forEach((shape, index) => it(`rejects malformed structure ${index + 1} after successful parsing`, () => {
    const { validation } = validateTemplate(JSON.stringify(shape));
    expect(validation).to.include({ parse: "valid", structure: "invalid", cloudFormation: "not-run" });
    expect(validation.issues.every(i => i.code === "TEMPLATE_STRUCTURE_ERROR" && !!i.path)).to.equal(true);
  }));

  it("preserves intrinsics, leaves the original untouched and validates deterministic fixes", () => {
    const text = `Parameters:
  Stage:
    Type: String
Resources:
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "sample-\${Stage}"
      Tags:
        - Key: Stage
          Value: !Ref Stage
Outputs:
  Arn:
    Value: !GetAtt Bucket.Arn
`;
    const original = parseTemplateInput(text);
    const snapshot = JSON.stringify(original);
    const fixes = analyzeTemplate(text).templateFixes!.filter(f => f.applicability === "applicable");
    const applied = applyTemplateFixes(original, fixes);
    expect(applied.appliedFixCount).to.equal(fixes.length);
    expect(applied.validation.structure).to.equal("valid");
    expect(applied.generatedTemplateStatus).to.equal("review-required");
    expect(canDownloadGeneratedTemplate(applied.validation)).to.equal(true);
    expect(JSON.stringify(original)).to.equal(snapshot);
    expect(applied.modifiedTemplate.Resources.Bucket.Properties!.BucketName).to.deep.equal({ "Fn::Sub": "sample-${Stage}" });
    expect(applied.modifiedTemplate.Resources.Bucket.Properties!.Tags).to.deep.equal(original.Resources.Bucket.Properties!.Tags);
    expect(applied.modifiedTemplate.Outputs).to.deep.equal(original.Outputs);
    expect(applyTemplateFixes(original, fixes)).to.deep.equal(applied);
  });

  it("detects a structurally broken patch without hiding its output or reverting unrelated fixes", () => {
    const template = parseTemplateInput(json);
    template.Resources.OtherBucket = { Type: "AWS::S3::Bucket" };
    const good = analyzeTemplate(json).templateFixes!.find(f => f.source.kind === "finding" && f.source.ruleId === "S3_VERSIONING_DISABLED")!;
    const broken: TemplateFix = { ...good, id: "broken-properties", patches: [{
      targetResourceId: "Bucket", targetResourceType: "AWS::S3::Bucket", path: ["Properties"],
      operation: "set", value: [], allowCreate: true
    }] };
    const unrelated = analyzeTemplate(JSON.stringify(template)).templateFixes!.find(f =>
      f.targetResourceId === "OtherBucket" && f.source.kind === "finding" && f.source.ruleId === "S3_VERSIONING_DISABLED")!;
    const result = applyTemplateFixes(template, [unrelated, broken]);
    expect(result.appliedFixCount).to.equal(2);
    expect(result.validation.structure).to.equal("invalid");
    expect(result.generatedTemplateStatus).to.equal("invalid");
    expect(result.validation.issues[0].relatedFixIds).to.deep.equal([broken.id]);
    expect(result.modifiedTemplate.Resources.Bucket.Properties).to.deep.equal([]);
    expect(result.modifiedTemplate.Resources.OtherBucket.Properties!.VersioningConfiguration).to.deep.equal({ Status: "Enabled" });
    expect(canDownloadGeneratedTemplate(result.validation)).to.equal(false);
    expect(template.Resources.Bucket.Properties).to.equal(undefined);
    expect(template.Resources.OtherBucket.Properties).to.equal(undefined);
  });

  it("requires local checks and blocks AWS-invalid output, while distinguishing unavailable", () => {
    const local = validateTemplate(json).validation;
    expect(canDownloadGeneratedTemplate(undefined)).to.equal(false);
    expect(getGeneratedTemplateStatus({ ...local, cloudFormation: "valid" })).to.equal("ready");
    expect(getGeneratedTemplateStatus({ ...local, cloudFormation: "unavailable" })).to.equal("review-required");
    expect(canDownloadGeneratedTemplate({ ...local, cloudFormation: "invalid" })).to.equal(false);
    expect(canDownloadGeneratedTemplate({ ...local, structure: "not-run" })).to.equal(false);
  });

  it("reports parser locations and rejects unsupported YAML tags without silently dropping them", () => {
    const result = validateTemplate("Resources:\n  Bucket:\n    Type: !Unknown AWS::S3::Bucket");
    expect(result.validation.parse).to.equal("invalid");
    expect(result.validation.issues[0].message).to.contain("line 3");
    expect(result.validation.issues[0].message).to.contain("!Unknown");
  });

  it("rejects cyclic YAML aliases and non-finite values before recursive analysis", () => {
    for (const text of ["Resources: {}\nMetadata: &loop\n  nested: *loop", "Resources: {}\nMetadata:\n  value: .inf"]) {
      const result = validateTemplate(text);
      expect(result.validation).to.include({ parse: "valid", structure: "invalid" });
      expect(() => analyzeTemplate(text)).to.throw(TemplateValidationError);
    }
  });

  it("allows a shared acyclic YAML alias", () => {
    expect(validateTemplate("Resources: {}\nMetadata:\n  first: &value { name: example }\n  second: *value").validation.structure).to.equal("valid");
  });
});
