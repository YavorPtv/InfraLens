import { expect } from "chai";
import { describe, it } from "mocha";
import { join } from "node:path";
import { resolveDeploymentTarget, validateDeploymentTarget } from "../src/deployment-target";
import {
  prepareTestBootstrapTemplate, prepareTestFilePublishingPolicyRepair, prepareTestBootstrapVersionReadRepair,
  prepareTestApiTagPolicyRepair, prepareTestApiLoggingBoundaryRepair, readTestPolicies, testPolicyNames,
  type BootstrapSnapshot, type PolicyDocument
} from "../src/test-permissions";

const policies = readTestPolicies(join(__dirname, ".."));
const account = "230944684535";
const region = "eu-central-1";
const applicationStack = `arn:aws:cloudformation:${region}:${account}:stack/InfraLensTestStack/*`;
const executionRole = `arn:aws:iam::${account}:role/cdk-hnb659fds-cfn-exec-role-${account}-${region}`;
const boundaryArn = `arn:aws:iam::${account}:policy/InfraLensTestApplicationBoundary`;

// These are structural regression checks. They do not emulate IAM evaluation.
describe("test deployment policy package", () => {
  it("uses valid-sized documents with explicit actions and no production references", () => {
    for (const name of testPolicyNames) {
      const policy = policies[name];
      const serialized = JSON.stringify(policy);
      expect(policy.Version).to.equal("2012-10-17");
      expect(serialized.length, name).to.be.at.most(6144);
      expect(serialized).not.to.include("609124256824");
      expect(serialized).not.to.include("InfraLensProdStack");
      expect(serialized).not.to.include("AdministratorAccess");
      const statementNames = policy.Statement.map(item => item.Sid);
      expect(new Set(statementNames).size, name).to.equal(statementNames.length);
      for (const statement of policy.Statement) {
        expect(statement.Action.length).to.be.greaterThan(0);
        if (statement.Effect === "Allow") {
          for (const action of statement.Action) {
            expect(action, name).not.to.include("*");
          }
        }
      }
    }
  });

  it("gives the SSO login only preflight reads and three exact bootstrap role assumptions", () => {
    const statements = policies.deployer.Statement;
    const assume = statements.find(item => item.Sid === "AssumeOnlyTestDeploymentRoles")!;
    expect(assume.Resource).to.deep.equal(["deploy", "file-publishing", "lookup"].map(
      name => `arn:aws:iam::${account}:role/cdk-hnb659fds-${name}-role-${account}-${region}`
    ));
    expect(statements.flatMap(item => item.Action)).to.have.members([
      "sts:GetCallerIdentity", "cloudformation:DescribeStacks", "sts:AssumeRole", "sts:TagSession"
    ]);
  });

  it("limits deployment mutations to the application stack and passes one execution role", () => {
    const policy = policies["deployment-role"];
    const prepare = statement(policy, "PrepareApplicationChanges");
    const apply = statement(policy, "ApplyOrRollbackApplicationChanges");
    expect(prepare.Resource).to.equal(applicationStack);
    expect(apply.Resource).to.equal(applicationStack);
    expect(prepare.Condition?.StringEquals).to.deep.equal({
      "aws:RequestedRegion": region,
      "cloudformation:RoleArn": executionRole
    });
    const passRole = statement(policy, "PassOnlyTestExecutionRole");
    expect(passRole.Resource).to.equal(executionRole);
    expect(passRole.Condition?.StringEquals).to.deep.equal({ "iam:PassedToService": "cloudformation.amazonaws.com" });
    const teardown = statement(policy, "KeepTeardownAndBootstrapAdministrationSeparate");
    expect(teardown.Effect).to.equal("Deny");
    expect(teardown.Action).to.include("cloudformation:DeleteStack");
    expect(teardown.Resource).to.equal("*");
    const grants = policy.Statement.filter(item => item.Effect === "Allow");
    expect(grants.flatMap(item => item.Action)).not.to.include("cloudformation:DeleteStack");
  });

  it("requires and protects the administrator-owned application boundary", () => {
    const policy = policies["execution-iam"];
    for (const sid of ["CreateBoundedApplicationRoles", "ChangeOnlyBoundedRolePermissions"]) {
      const grant = statement(policy, sid);
      expect(grant.Resource).to.equal(`arn:aws:iam::${account}:role/InfraLensTestStack-*`);
      expect(grant.Condition?.StringEquals).to.deep.equal({ "iam:PermissionsBoundary": boundaryArn });
    }
    expect(statement(policy, "NeverRemoveApplicationBoundary").Effect).to.equal("Deny");
    const substitute = statement(policy, "NeverSubstituteApplicationBoundary");
    expect(substitute.Effect).to.equal("Deny");
    expect(substitute.Condition?.StringNotEquals).to.deep.equal({ "iam:PermissionsBoundary": boundaryArn });
    expect(statement(policy, "ProtectAdministratorOwnedPolicies").Effect).to.equal("Deny");
    const target = resolveDeploymentTarget("test");
    expect(target.applicationPermissionsBoundaryArn).to.equal(boundaryArn);
    expect(() => validateDeploymentTarget({ ...target, applicationPermissionsBoundaryArn: undefined }))
      .to.throw("permissions boundary");
    expect(() => validateDeploymentTarget({ ...target, applicationPermissionsBoundaryArn: boundaryArn + "Other" }))
      .to.throw("permissions boundary");
    expect(resolveDeploymentTarget("production").applicationPermissionsBoundaryArn).to.equal(undefined);
  });

  it("lets CloudFormation resolve only the test bootstrap version without granting runtime SSM access", () => {
    const executionPolicies = ["execution-iam", "execution-storage-compute", "execution-edge-auth"] as const;
    const ssmGrants = executionPolicies.flatMap(name => policies[name].Statement).filter(item =>
      item.Effect === "Allow" && item.Action.some(action => action.startsWith("ssm:"))
    );
    expect(ssmGrants).to.deep.equal([{
      Sid: "ReadTestBootstrapVersion",
      Effect: "Allow",
      Action: ["ssm:GetParameters"],
      Resource: `arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/hnb659fds/version`
    }]);
    expect(policies["application-boundary"].Statement.flatMap(item => item.Action))
      .not.to.include("ssm:GetParameters");
  });

  it("restricts application role passing by role prefix and AWS service", () => {
    const iamPolicy = policies["execution-iam"];
    const lambda = statement(iamPolicy, "PassApplicationRoleToLambda");
    expect(lambda.Resource).to.equal(`arn:aws:iam::${account}:role/InfraLensTestStack-AnalysisFunctionRole*`);
    expect(lambda.Condition?.StringEquals).to.deep.equal({ "iam:PassedToService": "lambda.amazonaws.com" });
    const gateway = statement(iamPolicy, "PassLoggingRoleToGateway");
    expect(gateway.Resource).to.equal(`arn:aws:iam::${account}:role/InfraLensTestStack-AnalysisApiCloudWatchRole*`);
    expect(gateway.Condition?.StringEquals).to.deep.equal({ "iam:PassedToService": "apigateway.amazonaws.com" });
  });

  it("keeps runtime data and file publishing in their own resource prefixes", () => {
    const runtime = policies["application-boundary"];
    expect(statement(runtime, "HistoryRows").Resource).to.deep.equal([
      `arn:aws:dynamodb:${region}:${account}:table/InfraLensTestStack-ProjectsTable*`,
      `arn:aws:dynamodb:${region}:${account}:table/InfraLensTestStack-RunsTable*`
    ]);
    expect(statement(runtime, "OwnerArtifacts").Resource)
      .to.equal("arn:aws:s3:::infralensteststack-artifactbucket*/owners/*");
    expect(statement(runtime, "NoIdentityAdministrationOrRoleChaining").Effect).to.equal("Deny");
    for (const grant of policies["file-publishing-role"].Statement) {
      expect(grant.Resource).to.match(/^arn:aws:s3:::cdk-hnb659fds-assets-230944684535-eu-central-1/);
      expect(grant.Action).not.to.include("s3:DeleteObject");
    }
  });

  it("requires ownership tags for generated API, Cognito and distribution resources", () => {
    const edge = policies["execution-edge-auth"];
    for (const sid of ["CreateTaggedRestApi", "CreateTaggedUserPool", "CreateTaggedDistribution"]) {
      expect(statement(edge, sid).Condition?.StringEquals).to.include({
        "aws:RequestTag/Project": "InfraLens", "aws:RequestTag/Environment": "test"
      });
    }
    for (const sid of ["ManageTaggedRestApiAndChildren", "ManageTaggedUserPoolConfiguration", "ManageTaggedDistribution"]) {
      expect(statement(edge, sid).Condition?.StringEquals).to.include({
        "aws:ResourceTag/Project": "InfraLens", "aws:ResourceTag/Environment": "test"
      });
    }
    for (const sid of ["KeepApiOwnershipTagsImmutable", "KeepPoolAndDistributionOwnershipTags", "KeepProjectTagValue", "KeepEnvironmentTagValue"]) {
      expect(statement(edge, sid).Effect).to.equal("Deny");
    }
    expect(statement(edge, "TagDistributionDuringCreation").Condition?.Null).to.deep.equal({
      "aws:ResourceTag/Project": "true", "aws:ResourceTag/Environment": "true"
    });
  });

  it("allows initial API ownership tags and protects their required values and removal", () => {
    const edge = policies["execution-edge-auth"];
    const removal = statement(edge, "KeepApiOwnershipTagsImmutable");
    expect(removal.Action).to.deep.equal(["apigateway:DELETE"]);
    expect(removal.Condition).to.deep.equal({
      "ForAnyValue:StringEquals": { "aws:TagKeys": ["Project", "Environment"] }
    });
    expect(statement(edge, "ManageApiTags").Action).to.include("apigateway:PUT");
    for (const [sid, key, value] of [
      ["KeepProjectTagValue", "Project", "InfraLens"],
      ["KeepEnvironmentTagValue", "Environment", "test"]
    ]) {
      const deny = statement(edge, sid);
      expect(deny.Effect).to.equal("Deny");
      expect(deny.Action).to.include("apigateway:PUT");
      expect(deny.Condition).to.deep.equal({
        StringNotEquals: { [`aws:RequestTag/${key}`]: value },
        "ForAnyValue:StringEquals": { "aws:TagKeys": [key] }
      });
    }
  });

  it("limits account-level logging in the boundary to the test API Gateway logging role", () => {
    const grant = statement(policies["application-boundary"], "ApiGatewayAccountLogging");
    expect(grant.Effect).to.equal("Allow");
    expect(grant.Action).to.have.members([
      "logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogGroups", "logs:DescribeLogStreams",
      "logs:PutLogEvents", "logs:GetLogEvents", "logs:FilterLogEvents"
    ]);
    expect(grant.Resource).to.equal("*");
    expect(grant.Condition).to.deep.equal({
      StringEquals: { "aws:RequestedRegion": region },
      ArnLike: { "aws:PrincipalArn": `arn:aws:iam::${account}:role/InfraLensTestStack-AnalysisApiCloudWatchRole*` }
    });
    expect(JSON.stringify(grant)).not.to.include("AnalysisFunctionRole");
  });
});

describe("offline test bootstrap policy preparation", () => {
  it("preserves bootstrap storage, image publishing, names and version while replacing role permissions", () => {
    const snapshot = exampleSnapshot();
    const original = structuredClone(snapshot);
    const template = prepareTestBootstrapTemplate(snapshot, policies);
    expect(snapshot).to.deep.equal(original);
    for (const id of ["StagingBucket", "ImagePublishingRole", "CdkBootstrapVersion"]) {
      expect(template.Resources[id]).to.deep.equal(original.TemplateBody.Resources[id]);
    }
    for (const id of ["DeploymentActionRole", "FilePublishingRole", "LookupRole", "CloudFormationExecutionRole"]) {
      expect(template.Resources[id].Properties.RoleName).to.deep.equal(original.TemplateBody.Resources[id].Properties.RoleName);
    }
    expect(template.Parameters.BootstrapVariant.Default).to.equal("InfraLensTestScopedV1");
    expect(template.Resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns).to.deep.equal([
      { Ref: "InfraLensTestExecutionIam" },
      { Ref: "InfraLensTestExecutionStorageCompute" },
      { Ref: "InfraLensTestExecutionEdgeAuth" }
    ]);
    expect(template.Resources.InfraLensTestApplicationBoundary.Properties.PolicyDocument).to.deep.equal(policies["application-boundary"]);
    expect(template.Resources.DeploymentActionRole.Properties.ManagedPolicyArns).to.equal(undefined);
    expect(template.Resources.LookupRole.Properties.ManagedPolicyArns).to.equal(undefined);
    expect(template.Resources.DeploymentActionRole.Properties.Policies[0].PolicyDocument).to.deep.equal(policies["deployment-role"]);
    expect(template.Resources.FilePublishingRole.Properties.Policies).to.equal(undefined);
    expect(template.Resources.FilePublishingRoleDefaultPolicy.Properties.PolicyDocument)
      .to.deep.equal(policies["file-publishing-role"]);
  });

  it("trusts only the dedicated test Identity Center permission set for routine CDK roles", () => {
    const template = prepareTestBootstrapTemplate(exampleSnapshot(), policies);
    for (const id of ["DeploymentActionRole", "FilePublishingRole", "LookupRole"]) {
      const trust = template.Resources[id].Properties.AssumeRolePolicyDocument.Statement[0];
      expect(trust.Principal).to.deep.equal({ AWS: `arn:aws:iam::${account}:root` });
      expect(trust.Condition.ArnLike["aws:PrincipalArn"])
        .to.equal(`arn:aws:iam::${account}:role/aws-reserved/sso.amazonaws.com/eu-central-1/AWSReservedSSO_InfraLensTestDeploy_*`);
      expect(trust.Condition.Null).to.deep.equal({ "sts:ExternalId": "true" });
    }
  });

  it("rejects a production, wrong-region, wrong-stack or unhealthy snapshot", () => {
    for (const stackId of [
      `arn:aws:cloudformation:${region}:609124256824:stack/CDKToolkit/id`,
      `arn:aws:cloudformation:us-east-1:${account}:stack/CDKToolkit/id`,
      `arn:aws:cloudformation:${region}:${account}:stack/InfraLensTestStack/id`
    ]) {
      const snapshot = exampleSnapshot();
      snapshot.Stacks[0].StackId = stackId;
      expect(() => prepareTestBootstrapTemplate(snapshot, policies)).to.throw("healthy CDKToolkit snapshot");
    }
    const snapshot = exampleSnapshot();
    snapshot.Stacks[0].StackStatus = "UPDATE_IN_PROGRESS";
    expect(() => prepareTestBootstrapTemplate(snapshot, policies)).to.throw("healthy CDKToolkit snapshot");
  });

  it("rejects changed bootstrap parameters, version or roles instead of overwriting customizations", () => {
    const customized = exampleSnapshot();
    customized.Stacks[0].Parameters.find(item => item.ParameterKey === "TrustedAccounts")!.ParameterValue = "609124256824";
    expect(() => prepareTestBootstrapTemplate(customized, policies)).to.throw("TrustedAccounts");
    const newer = exampleSnapshot();
    newer.TemplateBody.Resources.CdkBootstrapVersion.Properties.Value = "33";
    expect(() => prepareTestBootstrapTemplate(newer, policies)).to.throw("version 32");
    const renamed = exampleSnapshot();
    renamed.TemplateBody.Resources.DeploymentActionRole.Properties.RoleName = "custom";
    expect(() => prepareTestBootstrapTemplate(renamed, policies)).to.throw("Unexpected bootstrap role");
  });

  it("replaces the separately owned publishing policy so old delete grants do not survive", () => {
    const template = prepareTestBootstrapTemplate(exampleSnapshot(), policies);
    const attachedPolicies = Object.values(template.Resources).filter(resource =>
      resource.Type === "AWS::IAM::Policy" &&
      resource.Properties.Roles?.some((role: { Ref?: string }) => role.Ref === "FilePublishingRole")
    );
    expect(attachedPolicies).to.have.length(1);
    expect(attachedPolicies[0].Properties.PolicyDocument).to.deep.equal(policies["file-publishing-role"]);
    expect(JSON.stringify(attachedPolicies)).not.to.include("s3:DeleteObject");
    expect(JSON.stringify(attachedPolicies)).not.to.include("kms:");
  });

  it("rejects missing, renamed or shared publishing-policy resources", () => {
    const missing = exampleSnapshot();
    delete missing.TemplateBody.Resources.FilePublishingRoleDefaultPolicy;
    expect(() => prepareTestBootstrapTemplate(missing, policies)).to.throw("Unexpected FilePublishingRoleDefaultPolicy");
    const renamed = exampleSnapshot();
    renamed.TemplateBody.Resources.FilePublishingRoleDefaultPolicy.Properties.PolicyName = "custom";
    expect(() => prepareTestBootstrapTemplate(renamed, policies)).to.throw("Unexpected FilePublishingRoleDefaultPolicy");
    const shared = exampleSnapshot();
    shared.TemplateBody.Resources.FilePublishingRoleDefaultPolicy.Properties.Roles.push({ Ref: "ImagePublishingRole" });
    expect(() => prepareTestBootstrapTemplate(shared, policies)).to.throw("Unexpected FilePublishingRoleDefaultPolicy");
  });

  it("repairs the applied V1 omission with only two existing resource changes", () => {
    const snapshot = appliedV1Snapshot();
    const original = structuredClone(snapshot);
    const template = prepareTestFilePublishingPolicyRepair(snapshot, policies);
    const expected = structuredClone(original.TemplateBody);
    delete expected.Resources.FilePublishingRole.Properties.Policies;
    expected.Resources.FilePublishingRoleDefaultPolicy.Properties.PolicyDocument = policies["file-publishing-role"];
    expect(template).to.deep.equal(expected);
    expect(snapshot).to.deep.equal(original);
    expect(Object.keys(template.Resources)).to.deep.equal(Object.keys(original.TemplateBody.Resources));
  });

  it("rejects repairs for the wrong variant, account or customized role policies", () => {
    expect(() => prepareTestFilePublishingPolicyRepair(exampleSnapshot(), policies)).to.throw("BootstrapVariant");
    const wrongAccount = appliedV1Snapshot();
    wrongAccount.Stacks[0].StackId = wrongAccount.Stacks[0].StackId.replace(account, "609124256824");
    expect(() => prepareTestFilePublishingPolicyRepair(wrongAccount, policies)).to.throw("healthy CDKToolkit snapshot");
    const extraPolicy = appliedV1Snapshot();
    extraPolicy.TemplateBody.Resources.FilePublishingRole.Properties.Policies.push({ PolicyName: "custom" });
    expect(() => prepareTestFilePublishingPolicyRepair(extraPolicy, policies)).to.throw("original scoped V1");
    const managedPolicy = appliedV1Snapshot();
    managedPolicy.TemplateBody.Resources.FilePublishingRole.Properties.ManagedPolicyArns = ["arn:aws:iam::aws:policy/AdministratorAccess"];
    expect(() => prepareTestFilePublishingPolicyRepair(managedPolicy, policies)).to.throw("original scoped V1");
  });

  it("repairs the missing version read by changing only the execution storage/compute policy", () => {
    const snapshot = snapshotWithoutExecutionVersionRead();
    const original = structuredClone(snapshot);
    const template = prepareTestBootstrapVersionReadRepair(snapshot, policies);
    const expected = structuredClone(original.TemplateBody);
    expected.Resources.InfraLensTestExecutionStorageCompute.Properties.PolicyDocument = policies["execution-storage-compute"];
    expect(template).to.deep.equal(expected);
    expect(snapshot).to.deep.equal(original);
  });

  it("rejects version-read repairs for another account, region, stack or bootstrap variant", () => {
    for (const stackId of [
      `arn:aws:cloudformation:${region}:609124256824:stack/CDKToolkit/id`,
      `arn:aws:cloudformation:us-east-1:${account}:stack/CDKToolkit/id`,
      `arn:aws:cloudformation:${region}:${account}:stack/InfraLensTestStack/id`
    ]) {
      const snapshot = snapshotWithoutExecutionVersionRead();
      snapshot.Stacks[0].StackId = stackId;
      expect(() => prepareTestBootstrapVersionReadRepair(snapshot, policies)).to.throw("healthy CDKToolkit snapshot");
    }
    expect(() => prepareTestBootstrapVersionReadRepair(exampleSnapshot(), policies)).to.throw("BootstrapVariant");
  });

  it("refuses to overwrite customized, detached or already corrected execution policies", () => {
    const customized = snapshotWithoutExecutionVersionRead();
    customized.TemplateBody.Resources.InfraLensTestExecutionStorageCompute.Properties.PolicyDocument.Statement.pop();
    expect(() => prepareTestBootstrapVersionReadRepair(customized, policies)).to.throw("differs from the known");
    const detached = snapshotWithoutExecutionVersionRead();
    detached.TemplateBody.Resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns = [];
    expect(() => prepareTestBootstrapVersionReadRepair(detached, policies)).to.throw("attached to the CloudFormation");
    const corrected = snapshotWithoutExecutionVersionRead();
    corrected.TemplateBody = prepareTestBootstrapVersionReadRepair(corrected, policies);
    expect(() => prepareTestBootstrapVersionReadRepair(corrected, policies)).to.throw("already corrected");
  });

  it("rejects a broader parameter grant in the repair input", () => {
    const broaderPolicies = structuredClone(policies);
    statement(broaderPolicies["execution-storage-compute"], "ReadTestBootstrapVersion").Resource = "*";
    expect(() => prepareTestBootstrapVersionReadRepair(snapshotWithoutExecutionVersionRead(), broaderPolicies))
      .to.throw("exact test bootstrap version");
  });

  it("repairs only the API tagging deny rules while preserving the applied version-read fix", () => {
    const snapshot = snapshotWithApiTaggingDefect();
    const original = structuredClone(snapshot);
    const template = prepareTestApiTagPolicyRepair(snapshot, policies);
    const expected = structuredClone(original.TemplateBody);
    expected.Resources.InfraLensTestExecutionEdgeAuth.Properties.PolicyDocument = policies["execution-edge-auth"];
    expect(template).to.deep.equal(expected);
    expect(snapshot).to.deep.equal(original);
    expect(template.Resources.InfraLensTestExecutionStorageCompute.Properties.PolicyDocument)
      .to.deep.equal(policies["execution-storage-compute"]);
  });

  it("rejects API tagging repairs for the wrong account or unexpected existing policy changes", () => {
    const wrongAccount = snapshotWithApiTaggingDefect();
    wrongAccount.Stacks[0].StackId = wrongAccount.Stacks[0].StackId.replace(account, "609124256824");
    expect(() => prepareTestApiTagPolicyRepair(wrongAccount, policies)).to.throw("healthy CDKToolkit snapshot");
    const customized = snapshotWithApiTaggingDefect();
    customized.TemplateBody.Resources.InfraLensTestExecutionEdgeAuth.Properties.PolicyDocument.Statement.pop();
    expect(() => prepareTestApiTagPolicyRepair(customized, policies)).to.throw("differs from the known tagging defect");
    const corrected = snapshotWithApiTaggingDefect();
    corrected.TemplateBody = prepareTestApiTagPolicyRepair(corrected, policies);
    expect(() => prepareTestApiTagPolicyRepair(corrected, policies)).to.throw("already corrected");
    const detached = snapshotWithApiTaggingDefect();
    detached.TemplateBody.Resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns = [];
    expect(() => prepareTestApiTagPolicyRepair(detached, policies)).to.throw("attached to the CloudFormation");
  });

  it("repairs only the application boundary and preserves all bootstrap role and resource settings", () => {
    const snapshot = snapshotWithApiLoggingRestriction();
    const original = structuredClone(snapshot);
    const template = prepareTestApiLoggingBoundaryRepair(snapshot, policies);
    const expected = structuredClone(original.TemplateBody);
    expected.Resources.InfraLensTestApplicationBoundary.Properties.PolicyDocument = policies["application-boundary"];
    expect(template).to.deep.equal(expected);
    expect(snapshot).to.deep.equal(original);
  });

  it("rejects logging-boundary repairs for production, customization or an already applied correction", () => {
    const wrongAccount = snapshotWithApiLoggingRestriction();
    wrongAccount.Stacks[0].StackId = wrongAccount.Stacks[0].StackId.replace(account, "609124256824");
    expect(() => prepareTestApiLoggingBoundaryRepair(wrongAccount, policies)).to.throw("healthy CDKToolkit snapshot");
    const customized = snapshotWithApiLoggingRestriction();
    customized.TemplateBody.Resources.InfraLensTestApplicationBoundary.Properties.PolicyDocument.Statement.pop();
    expect(() => prepareTestApiLoggingBoundaryRepair(customized, policies)).to.throw("differs from the known logging restriction");
    const corrected = snapshotWithApiLoggingRestriction();
    corrected.TemplateBody = prepareTestApiLoggingBoundaryRepair(corrected, policies);
    expect(() => prepareTestApiLoggingBoundaryRepair(corrected, policies)).to.throw("already corrected");
    const broaderPolicies = structuredClone(policies);
    statement(broaderPolicies["application-boundary"], "ApiGatewayAccountLogging").Condition!.ArnLike["aws:PrincipalArn"] = "*";
    expect(() => prepareTestApiLoggingBoundaryRepair(snapshotWithApiLoggingRestriction(), broaderPolicies))
      .to.throw("restricted to the test API Gateway role and region");
  });
});

function snapshotWithApiLoggingRestriction(): BootstrapSnapshot {
  const snapshot = exampleSnapshot();
  const previousPolicies = structuredClone(policies);
  previousPolicies["application-boundary"].Statement = previousPolicies["application-boundary"].Statement
    .filter(item => item.Sid !== "ApiGatewayAccountLogging");
  snapshot.TemplateBody = prepareTestBootstrapTemplate(snapshot, previousPolicies);
  snapshot.Stacks[0].StackStatus = "UPDATE_COMPLETE";
  snapshot.Stacks[0].Parameters.find(item => item.ParameterKey === "BootstrapVariant")!.ParameterValue = "InfraLensTestScopedV1";
  return snapshot;
}

function snapshotWithApiTaggingDefect(): BootstrapSnapshot {
  const snapshot = exampleSnapshot();
  const previousPolicies = structuredClone(policies);
  const edge = previousPolicies["execution-edge-auth"];
  statement(edge, "KeepApiOwnershipTagsImmutable").Action = ["apigateway:PUT", "apigateway:DELETE"];
  for (const sid of ["KeepProjectTagValue", "KeepEnvironmentTagValue"]) {
    statement(edge, sid).Action = ["cognito-idp:TagResource", "cloudfront:TagResource"];
  }
  snapshot.TemplateBody = prepareTestBootstrapTemplate(snapshot, previousPolicies);
  snapshot.Stacks[0].StackStatus = "UPDATE_COMPLETE";
  snapshot.Stacks[0].Parameters.find(item => item.ParameterKey === "BootstrapVariant")!.ParameterValue = "InfraLensTestScopedV1";
  return snapshot;
}

function snapshotWithoutExecutionVersionRead(): BootstrapSnapshot {
  const snapshot = exampleSnapshot();
  const previousPolicies = structuredClone(policies);
  previousPolicies["execution-storage-compute"].Statement = previousPolicies["execution-storage-compute"].Statement
    .filter(item => item.Sid !== "ReadTestBootstrapVersion");
  snapshot.TemplateBody = prepareTestBootstrapTemplate(snapshot, previousPolicies);
  snapshot.Stacks[0].StackStatus = "UPDATE_COMPLETE";
  snapshot.Stacks[0].Parameters.find(item => item.ParameterKey === "BootstrapVariant")!.ParameterValue = "InfraLensTestScopedV1";
  return snapshot;
}

function appliedV1Snapshot(): BootstrapSnapshot {
  const snapshot = exampleSnapshot();
  const oldPublishingPolicy = structuredClone(snapshot.TemplateBody.Resources.FilePublishingRoleDefaultPolicy);
  snapshot.TemplateBody = prepareTestBootstrapTemplate(snapshot, policies);
  snapshot.TemplateBody.Resources.FilePublishingRoleDefaultPolicy = oldPublishingPolicy;
  snapshot.TemplateBody.Resources.FilePublishingRole.Properties.Policies = [{
    PolicyName: "InfraLensTestScopedAccess", PolicyDocument: policies["file-publishing-role"]
  }];
  snapshot.Stacks[0].StackStatus = "UPDATE_COMPLETE";
  snapshot.Stacks[0].Parameters.find(item => item.ParameterKey === "BootstrapVariant")!.ParameterValue = "InfraLensTestScopedV1";
  return snapshot;
}

function statement(policy: PolicyDocument, sid: string) {
  const result = policy.Statement.find(item => item.Sid === sid);
  expect(result, sid).not.to.equal(undefined);
  return result!;
}

function exampleSnapshot(): BootstrapSnapshot {
  const resources: BootstrapSnapshot["TemplateBody"]["Resources"] = {
    CdkBootstrapVersion: { Type: "AWS::SSM::Parameter", Properties: { Value: "32" } },
    StagingBucket: { Type: "AWS::S3::Bucket", Properties: { VersioningConfiguration: { Status: "Enabled" } } },
    ImagePublishingRole: { Type: "AWS::IAM::Role", Properties: { RoleName: "unchanged-image-role" } },
    FilePublishingRoleDefaultPolicy: {
      Type: "AWS::IAM::Policy",
      Properties: {
        PolicyName: { "Fn::Sub": "cdk-${Qualifier}-file-publishing-role-default-policy-${AWS::AccountId}-${AWS::Region}" },
        Roles: [{ Ref: "FilePublishingRole" }],
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: ["s3:DeleteObject*", "s3:PutObject*"], Resource: { "Fn::Sub": "${StagingBucket.Arn}/*" } }]
        }
      }
    }
  };
  for (const [id, description] of Object.entries({
    DeploymentActionRole: "deploy", FilePublishingRole: "file-publishing", LookupRole: "lookup", CloudFormationExecutionRole: "cfn-exec"
  })) {
    resources[id] = {
      Type: "AWS::IAM::Role",
      Properties: {
        RoleName: { "Fn::Sub": `cdk-\${Qualifier}-${description}-role-\${AWS::AccountId}-\${AWS::Region}` },
        ManagedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"],
        AssumeRolePolicyDocument: { Statement: [{ Principal: { AWS: `arn:aws:iam::${account}:root` } }] }
      }
    };
  }
  return {
    Stacks: [{
      StackId: `arn:aws:cloudformation:${region}:${account}:stack/CDKToolkit/example`,
      StackStatus: "CREATE_COMPLETE",
      Parameters: Object.entries({
        Qualifier: "hnb659fds", FileAssetsBucketKmsKeyId: "AWS_MANAGED_KEY", InputPermissionsBoundary: "",
        UseExamplePermissionsBoundary: "false", CloudFormationExecutionPolicies: "", TrustedAccounts: "",
        TrustedAccountsForLookup: "", BootstrapVariant: "AWS CDK: Default Resources"
      }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }))
    }],
    TemplateBody: { Resources: resources, Parameters: { BootstrapVariant: { Default: "AWS CDK: Default Resources" } } }
  };
}
