import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDeploymentTarget } from "./deployment-target";
import { loadHostedTestConfiguration, parseHostedTestRequest } from "./hosted-test-workflow";
import type { PolicyDocument } from "./test-permissions";

// Offline preparation only: no credentials, child processes or AWS calls.
export function createTestStoragePolicy(targetName: unknown, outputs: unknown): PolicyDocument {
  const target = resolveDeploymentTarget(targetName);
  if (target.name !== "test") {
    throw new Error("Storage-test permissions accept only --target test; production is prohibited.");
  }
  const request = parseHostedTestRequest(["smoke", "--target", target.name], ".");
  const configuration = loadHostedTestConfiguration(request, outputs);
  const tablePrefix = `arn:aws:dynamodb:${target.region}:${target.account}:table/`;
  const artifactPrefix = `arn:aws:s3:::${configuration.artifactBucket}/owners/test-*/projects/*/runs/*`;
  const regionCondition = { "aws:RequestedRegion": target.region };

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "VerifyCallerIdentity",
        Effect: "Allow",
        Action: ["sts:GetCallerIdentity"],
        Resource: "*"
      },
      {
        Sid: "ReadTestStackOutputs",
        Effect: "Allow",
        Action: ["cloudformation:DescribeStacks"],
        Resource: `arn:aws:cloudformation:${target.region}:${target.account}:stack/${target.stackName}/*`,
        Condition: { StringEquals: regionCondition }
      },
      {
        Sid: "TestOwnerProjectRecords",
        Effect: "Allow",
        // TransactWriteItems uses the underlying PutItem permission.
        Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        Resource: `${tablePrefix}${configuration.projectsTable}`,
        Condition: {
          StringEquals: regionCondition,
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["OWNER#test-*"] },
          Null: { "dynamodb:LeadingKeys": "false" }
        }
      },
      {
        Sid: "TestOwnerRunRecords",
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        Resource: `${tablePrefix}${configuration.runsTable}`,
        Condition: {
          StringEquals: regionCondition,
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["OWNER#test-*#PROJECT#*"] },
          Null: { "dynamodb:LeadingKeys": "false" }
        }
      },
      {
        Sid: "TestOwnerArtifacts",
        Effect: "Allow",
        // Tagged PutObject requests need PutObjectTagging as well as PutObject.
        Action: ["s3:GetObject", "s3:PutObject", "s3:PutObjectTagging", "s3:DeleteObject"],
        Resource: artifactPrefix,
        Condition: { StringEquals: { ...regionCondition, "s3:ResourceAccount": target.account } }
      }
    ]
  };
}

export function prepareTestStoragePolicy(args: string[], cdkDirectory = resolve(__dirname, "..")): string {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--target", "--outputs"].includes(name) || !value || value.startsWith("--") || options[name] !== undefined) {
      throw new Error("Use --target test and optionally --outputs <test-outputs.json>; options cannot be repeated.");
    }
    options[name] = value;
  }
  // Reject missing/production targets before opening an outputs file.
  const target = resolveDeploymentTarget(options["--target"]);
  if (target.name !== "test") {
    throw new Error("Storage-test permissions accept only --target test; production is prohibited.");
  }
  const outputsPath = options["--outputs"]
    ? resolve(options["--outputs"])
    : join(cdkDirectory, "cdk-outputs.test.json");
  const policyPath = join(cdkDirectory, "cdk.out", "test-storage.policy.json");
  if (resolve(outputsPath) === resolve(policyPath)) {
    throw new Error("Keep deployment outputs separate from the generated policy.");
  }
  const outputs: unknown = JSON.parse(readFileSync(outputsPath, "utf8").replace(/^\uFEFF/, ""));
  const policy = createTestStoragePolicy(target.name, outputs);
  mkdirSync(join(cdkDirectory, "cdk.out"), { recursive: true });
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return policyPath;
}

if (require.main === module) {
  try {
    const policyPath = prepareTestStoragePolicy(process.argv.slice(2));
    console.log(`Prepared storage-test inline policy: ${policyPath}. Nothing was applied to AWS.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Storage-test policy preparation failed.");
    process.exitCode = 1;
  }
}
