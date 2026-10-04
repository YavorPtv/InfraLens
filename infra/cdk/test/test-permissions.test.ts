import { expect } from "chai";
import { describe, it } from "mocha";
import { join } from "node:path";
import { resolveDeploymentTarget, validateDeploymentTarget } from "../src/deployment-target";
import {
  prepareTestBootstrapTemplate, readTestPolicies, testPolicyNames,
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
});

function statement(policy: PolicyDocument, sid: string) {
  const result = policy.Statement.find(item => item.Sid === sid);
  expect(result, sid).not.to.equal(undefined);
  return result!;
}

function exampleSnapshot(): BootstrapSnapshot {
  const resources: BootstrapSnapshot["TemplateBody"]["Resources"] = {
    CdkBootstrapVersion: { Type: "AWS::SSM::Parameter", Properties: { Value: "32" } },
    StagingBucket: { Type: "AWS::S3::Bucket", Properties: { VersioningConfiguration: { Status: "Enabled" } } },
    ImagePublishingRole: { Type: "AWS::IAM::Role", Properties: { RoleName: "unchanged-image-role" } }
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
