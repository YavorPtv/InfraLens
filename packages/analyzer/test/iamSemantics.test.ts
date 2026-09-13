import { expect } from "chai";
import type { CfnTemplate, CfnValue } from "@infralens/shared";
import { analyzeTemplate, generateLeastPrivilegeResourceSuggestions, inferIamActionsFromSourceCode } from "../src";
import { analyzeIamCondition } from "../src/iamConditions";
import { buildIamAnalysis } from "../src/iamPolicyModel";

describe("partial IAM policy semantics", () => {
  it("treats prototype-like condition keys as unknown rather than metadata", () => {
    expect(analyzeIamCondition(JSON.parse('{"StringEquals":{"constructor":"value","__proto__":"value"}}')).unknown).to.deep.equal(["StringEquals constructor", "StringEquals __proto__"]);
  });
  it("does not narrow a policy also attached to an unresolved external identity", () => {
    const template = templateWith();
    template.Resources.Role.Properties = {};
    template.Resources.Policy = { Type: "AWS::IAM::ManagedPolicy", Properties: { Roles: [{ Ref: "Role" }, "external-role"], PolicyDocument: { Statement: { Effect: "Allow", Action: "s3:*", Resource: "*" } } } };
    const suggestion = suggestions(template)[0];
    expect(suggestion.manualOnly).to.equal(true);
    expect(suggestion.explanation).to.include("identities InfraLens cannot resolve");
  });

  it("does not pick one branch of a conditional execution role", () => {
    const template = templateWith();
    template.Resources.OtherRole = template.Resources.Role;
    template.Resources.Function.Properties!.Role = { "Fn::If": ["UsePrimary", { "Fn::GetAtt": ["Role", "Arn"] }, { "Fn::GetAtt": ["OtherRole", "Arn"] }] };
    expect(suggestions(template)).to.deep.equal([]);
  });
  it("distinguishes absent, understood and unknown conditions without declaring wildcards safe", () => {
    expect(analyzeIamCondition(undefined).status).to.equal("none");
    const known = { StringEquals: { "aws:SourceAccount": "123456789012", "aws:RequestedRegion": ["eu-west-1", "us-east-1"] }, Bool: { "aws:SecureTransport": true } };
    expect(analyzeIamCondition(known)).to.include({ status: "understood" });
    expect(analyzeIamCondition(known).restrictions).to.have.lengthOf(3);
    const report = analyzeTemplate(JSON.stringify(templateWith({ Condition: known })));
    const finding = report.findings.find(finding => finding.ruleId === "IAM_WILDCARD_PERMISSIONS")!;
    expect(finding).to.include({ severity: "high" });
    expect(finding.iamContext?.condition.value).to.deep.equal(known);
    expect(finding.explanation).to.include("do not establish");
    expect(finding.explanation).to.include("transport security");
    const mixed = analyzeIamCondition({ ...known, StringLike: { "s3:prefix": "private/*" } });
    expect(mixed.status).to.equal("unknown");
    expect(mixed.restrictions).to.have.lengthOf(3);
    expect(mixed.unknown).to.deep.equal(["StringLike s3:prefix"]);
  });

  for (const key of ["aws:SourceArn", "aws:PrincipalArn"]) it(`recognizes literal equality for ${key}`, () => {
    expect(analyzeIamCondition({ ArnEquals: { [key]: "arn:aws:iam::123456789012:role/Publisher" } }).status).to.equal("understood");
  });
  for (const condition of [
    { StringEqualsIfExists: { "aws:SourceAccount": "123456789012" } },
    { "ForAllValues:StringEquals": { "aws:SourceAccount": "123456789012" } },
    { StringNotEquals: { "aws:RequestedRegion": "eu-west-1" } },
    { ArnEquals: { "aws:PrincipalArn": "*" } },
    { ArnEquals: { "aws:PrincipalArn": "arn:aws:iam::123456789012:role/${aws:username}" } },
    { StringEquals: { "aws:SourceAccount": { Ref: "Account" } } }, {}, { "Fn::If": ["Condition", {}, {}] }
  ] as CfnValue[]) it(`leaves uncertain condition semantics unknown: ${JSON.stringify(condition)}`, () => {
    expect(analyzeIamCondition(condition).status).to.equal("unknown");
  });

  for (const condition of [{ StringEquals: { "aws:SourceAccount": "123456789012" } }, { StringLike: { "custom:key": "value" } }] as Record<string, CfnValue>[]) {
    it(`makes conditional replacements manual: ${JSON.stringify(condition)}`, () => {
      const template = templateWith({ Condition: condition });
      const suggestion = suggestions(template)[0];
      expect(suggestion).to.include({ manualOnly: true, confidence: "low" });
      expect(suggestion.iamContext?.condition.value).to.deep.equal(condition);
      expect(suggestion.explanation).to.include("Conditions limit");
      if ("StringLike" in condition) expect(suggestion.explanation).to.include("did not fully evaluate");
    });
  }

  it("inspects attached template managed policies and preserves their evidence", () => {
    const template = templateWith();
    const document = { Statement: { Effect: "Allow", Action: "s3:*", Resource: "*" } };
    template.Resources.Role.Properties = { ManagedPolicyArns: [{ Ref: "Policy" }] };
    template.Resources.Policy = { Type: "AWS::IAM::ManagedPolicy", Properties: { PolicyDocument: document } };
    const model = buildIamAnalysis(template);
    expect(model.policies[0]).to.include({ kind: "managed-policy-resource", resourceId: "Policy" });
    expect(model.policies[0].principalIds).to.deep.equal(["Role"]);
    expect(model.policies[0].document).to.deep.equal(document);
    const report = analyzeTemplate(JSON.stringify(template));
    const finding = report.findings.find(value => value.ruleId === "IAM_WILDCARD_PERMISSIONS")!;
    expect(finding.resourceId).to.equal("Policy");
    expect(finding.evidencePath).to.equal("Resources.Policy.Properties.PolicyDocument.Statement");
    expect(finding.iamContext?.principalIds).to.deep.equal(["Role"]);
    expect(suggestions(template)[0].policySourceType).to.equal("managed-policy-resource");
  });

  for (const type of ["Role", "User", "Group"]) it(`associates managed Policies with ${type}s through names and references`, () => {
    const template: CfnTemplate = { Resources: {
      Identity: { Type: `AWS::IAM::${type}`, Properties: { [`${type}Name`]: "identity" } },
      Policy: { Type: "AWS::IAM::ManagedPolicy", Properties: { [`${type}s`]: ["identity", { Ref: "Identity" }], PolicyDocument: { Statement: { Effect: "Allow", Action: "s3:*", Resource: "*" } } } }
    } };
    expect(buildIamAnalysis(template).policies[0].principalIds).to.deep.equal(["Identity"]);
    expect(analyzeTemplate(JSON.stringify(template)).findings.find(value => value.ruleId === "IAM_WILDCARD_PERMISSIONS")?.resourceId).to.equal("Policy");
  });

  it("records external managed policies without fabricating internal actions", () => {
    const template: CfnTemplate = { Resources: { Role: { Type: "AWS::IAM::Role", Properties: { ManagedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess", { "Fn::ImportValue": "ExternalPolicy" }] } } } };
    const report = analyzeTemplate(JSON.stringify(template));
    expect(report.findings).to.deep.equal([]);
    expect(report.iamAnalysis?.principals[0].managedPolicies.map(policy => policy.status)).to.deep.equal(["unresolved", "unresolved"]);
    expect(report.iamAnalysis?.limitations.join(" ")).to.include("contents were not inspected");
    const withInline = templateWith();
    withInline.Resources.Role.Properties!.ManagedPolicyArns = ["arn:aws:iam::123456789012:policy/Unknown"];
    expect(suggestions(withInline)[0]).to.include({ manualOnly: true, confidence: "low" });
    expect(suggestions(withInline)[0].explanation).to.include("contents are unknown");
  });

  for (const local of [false, true]) it(`preserves ${local ? "template" : "external"} permissions boundaries without simulating an intersection`, () => {
    const template = templateWith();
    template.Resources.Role.Properties!.PermissionsBoundary = local ? { Ref: "Boundary" } : "arn:aws:iam::123456789012:policy/Boundary";
    if (local) template.Resources.Boundary = { Type: "AWS::IAM::ManagedPolicy", Properties: { PolicyDocument: { Statement: { Effect: "Allow", Action: "*", Resource: "*" } } } };
    const report = analyzeTemplate(JSON.stringify(template));
    expect(report.iamAnalysis?.principals[0].permissionsBoundary?.status).to.equal(local ? "template-defined" : "unresolved");
    expect(report.findings.filter(value => value.ruleId === "IAM_WILDCARD_PERMISSIONS")).to.have.lengthOf(1);
    expect(suggestions(template)[0]).to.include({ manualOnly: true, confidence: "low" });
    expect(suggestions(template)[0].explanation).to.include("boundary");
  });

  it("preserves a user boundary and standalone Deny evidence", () => {
    const template = templateWith();
    template.Resources.User = { Type: "AWS::IAM::User", Properties: { PermissionsBoundary: { Ref: "BoundaryArn" } } };
    template.Resources.Deny = { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: "Role" }], PolicyDocument: { Statement: { Effect: "Deny", Action: "s3:*", Resource: "*" } } } };
    const report = analyzeTemplate(JSON.stringify(template));
    expect(report.iamAnalysis?.principals.find(principal => principal.resourceId === "User")?.permissionsBoundary?.status).to.equal("unresolved");
    expect(report.findings.filter(value => value.ruleId.startsWith("IAM_")).map(value => value.resourceId)).to.deep.equal(["Role"]);
    expect(suggestions(template)[0].iamContext?.explicitDenyEvidencePaths).to.deep.equal(["Resources.Deny.Properties.PolicyDocument.Statement"]);
    expect(suggestions(template)[0].manualOnly).to.equal(true);
  });

  it("keeps a local but conditional boundary document unresolved", () => {
    const template = templateWith();
    template.Resources.Role.Properties!.PermissionsBoundary = { Ref: "Boundary" };
    template.Resources.Boundary = { Type: "AWS::IAM::ManagedPolicy", Properties: { PolicyDocument: { "Fn::If": ["UseStrict", { Statement: { Effect: "Allow", Action: "s3:GetObject", Resource: "*" } }, { Ref: "OtherDocument" }] } } };
    expect(buildIamAnalysis(template).principals[0].permissionsBoundary).to.include({ status: "unresolved", policyResourceId: "Boundary" });
    expect(suggestions(template)[0].manualOnly).to.equal(true);
  });

  it("never treats Deny wildcard or dangerous actions as a grant", () => {
    const template = templateWith({ Effect: "Deny", Action: ["s3:*", "iam:PassRole", "iam:PutRolePolicy"] });
    expect(analyzeTemplate(JSON.stringify(template)).findings.filter(value => value.ruleId.startsWith("IAM_"))).to.deep.equal([]);
    expect(suggestions(template)).to.deep.equal([]);
  });

  it("keeps PassRole and permission mutation findings condition-aware", () => {
    const template = templateWith({ Action: ["iam:PassRole", "iam:PutRolePolicy"], Condition: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } } });
    const findings = analyzeTemplate(JSON.stringify(template)).findings.filter(value => value.ruleId.startsWith("IAM_"));
    expect(findings.map(value => value.ruleId)).to.have.members(["IAM_PASSROLE_WILDCARD", "IAM_PRIVILEGE_ESCALATION_ACTIONS"]);
    expect(findings.every(value => value.explanation.includes("did not fully evaluate"))).to.equal(true);
  });

  it("propagates managed-policy exposure to an attached role, retaining base severity for condition modifiers", () => {
    const template = templateWith();
    template.Resources.Role.Properties = { ManagedPolicyArns: [{ Ref: "Managed" }] };
    const statement: Record<string, CfnValue> = { Effect: "Allow", Action: "s3:*", Resource: "*" };
    template.Resources.Managed = { Type: "AWS::IAM::ManagedPolicy", Properties: { PolicyDocument: { Statement: statement } } };
    template.Resources.Api = { Type: "AWS::ApiGateway::RestApi", Properties: { Body: { paths: { "/files": { get: {
      "x-amazon-apigateway-integration": { uri: { "Fn::Sub": "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${Function.Arn}/invocations" } }
    } } } } } };
    const finding = () => analyzeTemplate(JSON.stringify(template)).findings.find(value => value.ruleId === "IAM_WILDCARD_PERMISSIONS")!;
    expect(finding().severity).to.equal("critical");
    statement.Condition = { StringEquals: { "aws:SourceAccount": "123456789012" } };
    expect(finding().severity).to.equal("high");
    expect(finding().severityAdjustment).to.equal(undefined);
  });
});

function templateWith(overrides: Record<string, CfnValue> = {}): CfnTemplate {
  return { Resources: {
    Role: { Type: "AWS::IAM::Role", Properties: { Policies: [{ PolicyName: "Access", PolicyDocument: { Statement: { Effect: "Allow", Action: "s3:*", Resource: "*", ...overrides } } }] } },
    Function: { Type: "AWS::Lambda::Function", Properties: { Role: { "Fn::GetAtt": ["Role", "Arn"] }, Environment: { Variables: { BUCKET: { Ref: "Bucket" } } } } },
    Bucket: { Type: "AWS::S3::Bucket" }
  } };
}

function suggestions(template: CfnTemplate) {
  return generateLeastPrivilegeResourceSuggestions(template, { sourceActionInferences: inferIamActionsFromSourceCode({ "handler.ts": 'import { GetObjectCommand } from "@aws-sdk/client-s3"; new GetObjectCommand({ Bucket: bucket });' }, { template, sourceFileMappings: { "handler.ts": "Function" } }) });
}
