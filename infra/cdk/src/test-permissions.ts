import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveDeploymentTarget } from "./deployment-target";

export interface PolicyDocument {
  Version: string;
  Statement: Array<{
    Sid: string;
    Effect: "Allow" | "Deny";
    Action: string[];
    Resource: string | string[];
    Condition?: Record<string, Record<string, string | string[]>>;
  }>;
}

export const testPolicyNames = [
  "deployer", "deployment-role", "lookup-role", "file-publishing-role",
  "execution-iam", "execution-storage-compute", "execution-edge-auth", "application-boundary"
] as const;

export type TestPolicyName = typeof testPolicyNames[number];
export type TestPolicies = Record<TestPolicyName, PolicyDocument>;

export function readTestPolicies(directory = join(__dirname, "..")): TestPolicies {
  const policies = {} as TestPolicies;
  for (const name of testPolicyNames) {
    policies[name] = JSON.parse(readFileSync(join(directory, `test-${name}.policy.json`), "utf8"));
  }
  return policies;
}

interface BootstrapResource {
  Type: string;
  Properties: Record<string, any>;
  [key: string]: unknown;
}

export interface BootstrapTemplate {
  Resources: Record<string, BootstrapResource>;
  Parameters: Record<string, { Default?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface BootstrapSnapshot {
  Stacks: Array<{
    StackId: string;
    StackStatus: string;
    Parameters: Array<{ ParameterKey: string; ParameterValue: string }>;
  }>;
  TemplateBody: BootstrapTemplate;
}

function validatedBootstrapTemplate(snapshot: BootstrapSnapshot, expectedVariant: string): BootstrapTemplate {
  const target = resolveDeploymentTarget("test");
  const state = snapshot.Stacks?.[0];
  const expectedArn = `arn:aws:cloudformation:${target.region}:${target.account}:stack/CDKToolkit/`;
  if (snapshot.Stacks?.length !== 1 || !state?.StackId?.startsWith(expectedArn) ||
      !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(state.StackStatus)) {
    throw new Error("Expected a healthy CDKToolkit snapshot from test account 230944684535 in eu-central-1.");
  }
  const parameters = new Map(state.Parameters.map(item => [item.ParameterKey, item.ParameterValue]));
  const requiredParameters = {
    Qualifier: "hnb659fds",
    FileAssetsBucketKmsKeyId: "AWS_MANAGED_KEY",
    InputPermissionsBoundary: "",
    UseExamplePermissionsBoundary: "false",
    CloudFormationExecutionPolicies: "",
    TrustedAccounts: "",
    TrustedAccountsForLookup: "",
    BootstrapVariant: expectedVariant
  };
  for (const [name, expected] of Object.entries(requiredParameters)) {
    if (parameters.get(name) !== expected) {
      throw new Error(`Bootstrap parameter ${name} differs from the audited setup. Review it before preparing policies.`);
    }
  }
  const template = structuredClone(snapshot.TemplateBody);
  if (!template?.Resources || String(template.Resources.CdkBootstrapVersion?.Properties.Value) !== "32") {
    throw new Error("Expected a parsed bootstrap version 32 template. Convert TemplateBody from YAML to JSON first.");
  }
  const roleDescriptions = {
    DeploymentActionRole: "deploy",
    FilePublishingRole: "file-publishing",
    LookupRole: "lookup",
    CloudFormationExecutionRole: "cfn-exec"
  };
  for (const [id, description] of Object.entries(roleDescriptions)) {
    const role = template.Resources[id];
    const expectedName = `cdk-\${Qualifier}-${description}-role-\${AWS::AccountId}-\${AWS::Region}`;
    if (role?.Type !== "AWS::IAM::Role" || role.Properties.RoleName?.["Fn::Sub"] !== expectedName) {
      throw new Error(`Unexpected bootstrap role ${id}; no template was prepared.`);
    }
  }
  return template;
}

// Offline preparation only. This module never starts a process or calls AWS.
export function prepareTestBootstrapTemplate(snapshot: BootstrapSnapshot, policies: TestPolicies): BootstrapTemplate {
  const target = resolveDeploymentTarget("test");
  const template = validatedBootstrapTemplate(snapshot, "AWS CDK: Default Resources");
  const trustPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: `arn:aws:iam::${target.account}:root` },
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Condition: {
        ArnLike: {
          "aws:PrincipalArn": `arn:aws:iam::${target.account}:role/aws-reserved/sso.amazonaws.com/eu-central-1/AWSReservedSSO_InfraLensTestDeploy_*`
        },
        Null: { "sts:ExternalId": "true" }
      }
    }]
  };
  const rolePolicies: Record<string, TestPolicyName> = {
    DeploymentActionRole: "deployment-role",
    FilePublishingRole: "file-publishing-role",
    LookupRole: "lookup-role"
  };
  for (const [id, name] of Object.entries(rolePolicies)) {
    const properties = template.Resources[id].Properties;
    properties.AssumeRolePolicyDocument = structuredClone(trustPolicy);
    if (id !== "FilePublishingRole") {
      properties.Policies = [{ PolicyName: "InfraLensTestScopedAccess", PolicyDocument: policies[name] }];
    }
    delete properties.ManagedPolicyArns;
  }
  scopeFilePublishingPolicy(template, policies["file-publishing-role"]);

  const managedPolicies: Record<string, TestPolicyName> = {
    InfraLensTestApplicationBoundary: "application-boundary",
    InfraLensTestExecutionIam: "execution-iam",
    InfraLensTestExecutionStorageCompute: "execution-storage-compute",
    InfraLensTestExecutionEdgeAuth: "execution-edge-auth"
  };
  for (const [id, name] of Object.entries(managedPolicies)) {
    if (template.Resources[id]) {
      throw new Error(`Bootstrap already contains ${id}; review an update separately.`);
    }
    template.Resources[id] = {
      Type: "AWS::IAM::ManagedPolicy",
      Properties: { ManagedPolicyName: id, Path: "/", PolicyDocument: policies[name] }
    };
  }
  const executionRole = template.Resources.CloudFormationExecutionRole.Properties;
  executionRole.ManagedPolicyArns = Object.keys(managedPolicies)
    .filter(id => id !== "InfraLensTestApplicationBoundary")
    .map(id => ({ Ref: id }));
  delete executionRole.Policies;
  template.Parameters.BootstrapVariant.Default = "InfraLensTestScopedV1";
  return template;
}

// Repair only the known V1 publishing-policy omission, preserving all other template fields.
export function prepareTestFilePublishingPolicyRepair(snapshot: BootstrapSnapshot, policies: TestPolicies): BootstrapTemplate {
  const template = validatedBootstrapTemplate(snapshot, "InfraLensTestScopedV1");
  const role = template.Resources.FilePublishingRole.Properties;
  const expectedInline = [{
    PolicyName: "InfraLensTestScopedAccess", PolicyDocument: policies["file-publishing-role"]
  }];
  if (!isDeepStrictEqual(role.Policies, expectedInline) || role.ManagedPolicyArns?.length) {
    throw new Error("Expected the original scoped V1 file-publishing role; review other changes separately.");
  }
  scopeFilePublishingPolicy(template, policies["file-publishing-role"]);
  return template;
}

function scopeFilePublishingPolicy(template: BootstrapTemplate, policy: PolicyDocument): void {
  const resource = template.Resources.FilePublishingRoleDefaultPolicy;
  const properties = resource?.Properties;
  const expectedName = "cdk-${Qualifier}-file-publishing-role-default-policy-${AWS::AccountId}-${AWS::Region}";
  if (resource?.Type !== "AWS::IAM::Policy" ||
      properties?.PolicyName?.["Fn::Sub"] !== expectedName ||
      !isDeepStrictEqual(properties?.Roles, [{ Ref: "FilePublishingRole" }]) ||
      properties?.Users || properties?.Groups) {
    throw new Error("Unexpected FilePublishingRoleDefaultPolicy; review its name and attachments before preparing policies.");
  }
  // Bootstrap owns this inline policy as a separate resource. Adding Role.Policies would leave it active.
  properties.PolicyDocument = structuredClone(policy);
  delete template.Resources.FilePublishingRole.Properties.Policies;
}

// Add the missing CloudFormation parameter read without replacing unrelated bootstrap settings.
export function prepareTestBootstrapVersionReadRepair(snapshot: BootstrapSnapshot, policies: TestPolicies): BootstrapTemplate {
  const template = validatedBootstrapTemplate(snapshot, "InfraLensTestScopedV1");
  const policyId = "InfraLensTestExecutionStorageCompute";
  const resource = template.Resources[policyId];
  const properties = resource?.Properties;
  const executionRole = template.Resources.CloudFormationExecutionRole.Properties;
  const attached = executionRole.ManagedPolicyArns?.some((arn: { Ref?: string }) => arn.Ref === policyId);
  if (resource?.Type !== "AWS::IAM::ManagedPolicy" || properties?.ManagedPolicyName !== policyId ||
      properties.Path !== "/" || !attached) {
    throw new Error("Expected the scoped execution storage/compute policy attached to the CloudFormation execution role.");
  }
  const correctedPolicy = policies["execution-storage-compute"];
  const versionReads = correctedPolicy.Statement.filter(item => item.Sid === "ReadTestBootstrapVersion");
  if (!isDeepStrictEqual(versionReads, [{
    Sid: "ReadTestBootstrapVersion",
    Effect: "Allow",
    Action: ["ssm:GetParameters"],
    Resource: "arn:aws:ssm:eu-central-1:230944684535:parameter/cdk-bootstrap/hnb659fds/version"
  }])) {
    throw new Error("Expected only GetParameters on the exact test bootstrap version parameter.");
  }
  const previousPolicy = structuredClone(correctedPolicy);
  previousPolicy.Statement = previousPolicy.Statement.filter(item => item.Sid !== "ReadTestBootstrapVersion");
  if (!isDeepStrictEqual(properties.PolicyDocument, previousPolicy)) {
    throw new Error("Execution policy differs from the known version-read omission or is already corrected; review it separately.");
  }
  properties.PolicyDocument = structuredClone(correctedPolicy);
  return template;
}

// Repair the deny that incorrectly blocked initial writes of the required API ownership tags.
export function prepareTestApiTagPolicyRepair(snapshot: BootstrapSnapshot, policies: TestPolicies): BootstrapTemplate {
  const template = validatedBootstrapTemplate(snapshot, "InfraLensTestScopedV1");
  const policyId = "InfraLensTestExecutionEdgeAuth";
  const resource = template.Resources[policyId];
  const properties = resource?.Properties;
  const executionRole = template.Resources.CloudFormationExecutionRole.Properties;
  const attached = executionRole.ManagedPolicyArns?.some((arn: { Ref?: string }) => arn.Ref === policyId);
  if (resource?.Type !== "AWS::IAM::ManagedPolicy" || properties?.ManagedPolicyName !== policyId ||
      properties.Path !== "/" || !attached) {
    throw new Error("Expected the scoped edge/auth policy attached to the CloudFormation execution role.");
  }
  const previousPolicy = structuredClone(policies["execution-edge-auth"]);
  const removalDeny = previousPolicy.Statement.find(item => item.Sid === "KeepApiOwnershipTagsImmutable");
  if (!removalDeny || !isDeepStrictEqual(removalDeny.Action, ["apigateway:DELETE"])) {
    throw new Error("Expected the API ownership-tag removal protection.");
  }
  removalDeny.Action.unshift("apigateway:PUT");
  for (const sid of ["KeepProjectTagValue", "KeepEnvironmentTagValue"]) {
    const valueDeny = previousPolicy.Statement.find(item => item.Sid === sid);
    if (!valueDeny || !isDeepStrictEqual(valueDeny.Action, [
      "apigateway:PUT", "cognito-idp:TagResource", "cloudfront:TagResource"
    ])) {
      throw new Error(`Expected the corrected ${sid} protection.`);
    }
    valueDeny.Action = valueDeny.Action.filter(action => action !== "apigateway:PUT");
  }
  if (!isDeepStrictEqual(properties.PolicyDocument, previousPolicy)) {
    throw new Error("Edge/auth policy differs from the known tagging defect or is already corrected; review it separately.");
  }
  properties.PolicyDocument = structuredClone(policies["execution-edge-auth"]);
  return template;
}

if (require.main === module) {
  try {
    const [snapshotPath, outputPath, mode, ...extra] = process.argv.slice(2);
    const repairModes = ["--repair-file-publishing-policy", "--repair-bootstrap-version-read", "--repair-api-ownership-tags"];
    if (!snapshotPath || !outputPath || extra.length || (mode && !repairModes.includes(mode))) {
      throw new Error(`Usage: prepare-test-permissions <parsed-snapshot.json> <review-template.json> [${repairModes.join(" | ")}] (offline, test only).`);
    }
    const compactPath = `${outputPath}.compact.json`;
    if ([outputPath, compactPath].some(path => resolve(snapshotPath) === resolve(path))) {
      throw new Error("Keep the original snapshot: output must be a different file.");
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8").replace(/^\uFEFF/, ""));
    const policies = readTestPolicies();
    let template: BootstrapTemplate;
    if (mode === "--repair-file-publishing-policy") {
      template = prepareTestFilePublishingPolicyRepair(snapshot, policies);
    } else if (mode === "--repair-bootstrap-version-read") {
      template = prepareTestBootstrapVersionReadRepair(snapshot, policies);
    } else if (mode === "--repair-api-ownership-tags") {
      template = prepareTestApiTagPolicyRepair(snapshot, policies);
    } else {
      template = prepareTestBootstrapTemplate(snapshot, policies);
    }
    const compactTemplate = JSON.stringify(template);
    if (Buffer.byteLength(compactTemplate, "utf8") > 51200) {
      throw new Error("Prepared template exceeds CloudFormation's template-body limit. Review a separate upload workflow.");
    }
    writeFileSync(outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    writeFileSync(compactPath, compactTemplate, "utf8");
    console.log(`Prepared test bootstrap review template: ${resolve(outputPath)}. Nothing was applied to AWS.`);
    console.log(`Compact copy for CloudFormation's template-body limit: ${resolve(compactPath)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
