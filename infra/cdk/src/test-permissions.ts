import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

// Offline preparation only. This module never starts a process or calls AWS.
export function prepareTestBootstrapTemplate(snapshot: BootstrapSnapshot, policies: TestPolicies): BootstrapTemplate {
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
    BootstrapVariant: "AWS CDK: Default Resources"
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
    properties.Policies = [{ PolicyName: "InfraLensTestScopedAccess", PolicyDocument: policies[name] }];
    delete properties.ManagedPolicyArns;
  }

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

if (require.main === module) {
  try {
    const [snapshotPath, outputPath, ...extra] = process.argv.slice(2);
    if (!snapshotPath || !outputPath || extra.length) {
      throw new Error("Usage: prepare-test-permissions <parsed-snapshot.json> <review-template.json> (offline, test only).");
    }
    const compactPath = `${outputPath}.compact.json`;
    if ([outputPath, compactPath].some(path => resolve(snapshotPath) === resolve(path))) {
      throw new Error("Keep the original snapshot: output must be a different file.");
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8").replace(/^\uFEFF/, ""));
    const template = prepareTestBootstrapTemplate(snapshot, readTestPolicies());
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
