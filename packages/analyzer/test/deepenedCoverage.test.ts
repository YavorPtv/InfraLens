import { expect } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CfnTemplate, CfnValue } from "@infralens/shared";
import { analyzeTemplate, applyTemplateFixes } from "../src";

describe("realistic analyzer coverage regression", () => {
  const raw = readFileSync(resolve("../../examples/analyzer-coverage/template.json"), "utf8");
  const sourceFiles = Object.fromEntries(["files.ts", "fileService.ts", "sharedStorage.ts", "query.ts", "notAws.ts"].map(path => [path, readFileSync(resolve("../../examples/analyzer-coverage", path), "utf8")]));
  const options = { sourceFiles, sourceFileMappings: { "files.ts": "FilesFunction", "query.ts": "QueryFunction" }, sourceFileExclusions: ["fileService.ts", "sharedStorage.ts", "notAws.ts"] };

  it("splits S3 bucket and object actions and applies a reviewed fix without losing surrounding policy properties", () => {
    const template = JSON.parse(raw) as CfnTemplate;
    const properties = template.Resources.FilesRole.Properties!;
    const policies = properties.Policies as Array<Record<string, CfnValue>>;
    const document = policies[0].PolicyDocument as Record<string, CfnValue>;
    const original = document.Statement as Record<string, CfnValue>;
    document.Statement = [{ ...original, Sid: "ReadFiles" }, { Effect: "Allow", Action: "logs:PutLogEvents", Resource: "arn:aws:logs:eu-west-1:123456789012:log-group:app:*" }];
    const report = analyzeTemplate(JSON.stringify(template), options);
    const suggestion = report.leastPrivilegeSuggestions.find(value => value.roleId === "FilesRole")!;
    expect(suggestion.manualOnly).to.equal(undefined);
    expect(suggestion.suggestedStatements).to.deep.equal([
      { Effect: "Allow", Action: ["s3:ListBucket"], Resource: { "Fn::GetAtt": ["FilesBucket", "Arn"] } },
      { Effect: "Allow", Action: ["s3:GetObject"], Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": ["FilesBucket", "Arn"] }, "/*"]] } }
    ]);
    expect(suggestion.evidence.sourceActions?.[1]).to.include({ importedSymbol: "GetObjectCommand", localSymbol: "ReadObject", filePath: "sharedStorage.ts" });
    expect(suggestion.evidence.sourceActions?.[1].importChain).to.deep.equal(["files.ts", "fileService.ts", "sharedStorage.ts"]);
    const fix = report.templateFixes!.find(value => value.source.kind === "least-privilege" && value.targetResourceId === "FilesRole")!;
    expect(fix.applicability).to.equal("applicable");
    const applied = applyTemplateFixes(template, [fix]);
    expect(applied.appliedFixCount).to.equal(1);
    const modified = (applied.modifiedTemplate.Resources.FilesRole.Properties!.Policies as Array<Record<string, CfnValue>>)[0].PolicyDocument as Record<string, CfnValue>;
    expect(modified.Statement).to.deep.equal([{ ...suggestion.suggestedStatements![0], Sid: "ReadFiles" }, suggestion.suggestedStatements![1], document.Statement[1]]);
    expect(document.Statement).to.have.lengthOf(2);
    expect(modified.Version).to.equal("2012-10-17");
    (document.Statement[0] as Record<string, CfnValue>).Action = "s3:DeleteObject";
    expect(applyTemplateFixes(template, [fix]).failedFixCount).to.equal(1);
  });

  it("uses only the literal secondary index proven by source and template", () => {
    const report = analyzeTemplate(raw, options);
    const suggestion = report.leastPrivilegeSuggestions.find(value => value.roleId === "QueryRole")!;
    expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal([
      { "Fn::GetAtt": ["OrdersTable", "Arn"] },
      { "Fn::Join": ["", [{ "Fn::GetAtt": ["OrdersTable", "Arn"] }, "/index/ByCustomer"]] }
    ]);
    expect(suggestion.manualOnly).to.equal(undefined);
    expect(JSON.stringify(suggestion)).not.to.include("/index/*");
  });

  it("applies a template-defined managed policy fix at the policy document, preserving the role attachment", () => {
    const template = JSON.parse(raw) as CfnTemplate;
    template.Resources.FilesRole.Properties!.Policies = [];
    template.Resources.FilesRole.Properties!.ManagedPolicyArns = [{ Ref: "FilesManagedPolicy" }];
    template.Resources.ManagedRole.Properties!.ManagedPolicyArns = [];
    const managedReport = analyzeTemplate(JSON.stringify(template), { sourceFiles: { "handler.ts": 'import { GetObjectCommand } from "@aws-sdk/client-s3"; new GetObjectCommand({ Bucket: bucket });' }, sourceFileMappings: { "handler.ts": "FilesFunction" } });
    const fix = managedReport.templateFixes!.find(value => value.source.kind === "least-privilege" && value.targetResourceId === "FilesManagedPolicy")!;
    expect(fix).to.include({ targetResourceType: "AWS::IAM::ManagedPolicy", applicability: "applicable" });
    const result = applyTemplateFixes(template, [fix]);
    expect(result.appliedFixCount).to.equal(1);
    expect(result.modifiedTemplate.Resources.FilesRole.Properties!.ManagedPolicyArns).to.deep.equal([{ Ref: "FilesManagedPolicy" }]);
    const document = result.modifiedTemplate.Resources.FilesManagedPolicy.Properties!.PolicyDocument as Record<string, CfnValue>;
    expect(document.Statement).to.deep.equal({ Effect: "Allow", Action: "s3:GetObject", Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": ["FilesBucket", "Arn"] }, "/*"]] } });
  });

  for (const [name, input, manual] of [
    ["table only", "{ TableName: table }", false],
    ["dynamic index", "{ TableName: table, IndexName: index }", true],
    ["unknown index", '{ TableName: table, IndexName: "Missing" }', true],
    ["opaque input", "input", true],
    ["spread input", "{ TableName: table, ...extra }", true]
  ] as const) it(`handles DynamoDB ${name} without guessing`, () => {
    const report = analyzeTemplate(raw, { ...options, sourceFiles: { ...sourceFiles, "query.ts": `import { ScanCommand } from "@aws-sdk/client-dynamodb"; new ScanCommand(${input});` } });
    const suggestion = report.leastPrivilegeSuggestions.find(value => value.roleId === "QueryRole")!;
    expect(suggestion.manualOnly === true).to.equal(manual);
    if (!manual) expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal({ "Fn::GetAtt": ["OrdersTable", "Arn"] });
  });

  it("does not choose one Lambda's needs for a shared role or attached policy", () => {
    const template = JSON.parse(raw) as CfnTemplate;
    template.Resources.OtherFunction = { ...template.Resources.FilesFunction };
    const report = analyzeTemplate(JSON.stringify(template), options);
    expect(report.leastPrivilegeSuggestions.filter(value => value.roleId === "FilesRole").every(value => value.manualOnly)).to.equal(true);
    expect(report.leastPrivilegeSuggestions.find(value => value.roleId === "FilesRole")?.explanation).to.include("shared");
  });

  for (const modifier of ["Condition", "PermissionsBoundary", "Deny"] as const) it(`rejects a previously generated IAM fix after adding ${modifier}`, () => {
    const template = JSON.parse(raw) as CfnTemplate;
    const report = analyzeTemplate(raw, options);
    const fix = report.templateFixes!.find(value => value.source.kind === "least-privilege" && value.targetResourceId === "FilesRole")!;
    const properties = template.Resources.FilesRole.Properties!;
    if (modifier === "PermissionsBoundary") properties.PermissionsBoundary = "arn:aws:iam::123456789012:policy/Boundary";
    else {
      const document = (properties.Policies as Array<Record<string, CfnValue>>)[0].PolicyDocument as Record<string, CfnValue>;
      if (modifier === "Condition") (document.Statement as Record<string, CfnValue>).Condition = { Bool: { "aws:SecureTransport": true } };
      else document.Statement = [document.Statement, { Effect: "Deny", Action: "s3:GetObject", Resource: "*" }];
    }
    const result = applyTemplateFixes(template, [fix]);
    expect(result.appliedFixCount).to.equal(0);
    expect(result.failedFixCount).to.equal(1);
    expect(result.modifiedTemplate).to.deep.equal(template);
  });

  it("rejects overlapping statement-array and child-statement fixes before indices can shift", () => {
    const template = JSON.parse(raw) as CfnTemplate;
    const document = (template.Resources.FilesRole.Properties!.Policies as Array<Record<string, CfnValue>>)[0].PolicyDocument as Record<string, CfnValue>;
    document.Statement = [document.Statement, { Effect: "Allow", Action: "s3:GetObject", Resource: "*" }];
    const report = analyzeTemplate(JSON.stringify(template), options);
    const fixes = report.templateFixes!.filter(value => value.source.kind === "least-privilege" && value.targetResourceId === "FilesRole");
    expect(fixes).to.have.lengthOf(2);
    expect(fixes.every(fix => fix.applicability === "applicable")).to.equal(true);
    const result = applyTemplateFixes(template, fixes);
    expect(result.failedFixCount).to.equal(2);
    expect(result.modifiedTemplate).to.deep.equal(template);
  });

  it("does not require a second DLQ for a Lambda failure queue or ignore the function DLQ", () => {
    const findings = analyzeTemplate(raw).findings;
    expect(findings.filter(value => ["SQS_MISSING_DLQ", "LAMBDA_DEAD_LETTER_CONFIG_MISSING"].includes(value.ruleId))).to.deep.equal([]);
  });

  it("flags the fixture's unscoped service permission but not the API permission", () => {
    const findings = analyzeTemplate(raw).findings.filter(value => value.ruleId === "LAMBDA_SERVICE_PERMISSION_UNSCOPED");
    expect(findings).to.have.lengthOf(1);
    expect(findings[0]).to.include({ resourceId: "UnscopedSnsPermission", severity: "high", evidencePath: "Resources.UnscopedSnsPermission.Properties.Principal" });
  });
});
