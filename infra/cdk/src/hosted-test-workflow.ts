import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createFrontendConfigurations, deploymentProcessEnvironment, parseDeploymentRequest,
  verifyCallerAccount, type DeploymentRequest, type ProcessCall, type ProcessRunner
} from "./deployment-workflow";

type TestCommand = "smoke" | "hosted" | "storage" | "setup-users";
interface TestRequest {
  command: TestCommand;
  deployment: DeploymentRequest;
  outputsPath: string;
  authenticatedSmoke: boolean;
}

export interface HostedTestConfiguration {
  target: "test";
  account: string;
  region: string;
  stackName: string;
  profile: string;
  apiBaseUrl: string;
  projectsTable: string;
  runsTable: string;
  artifactBucket: string;
  userPoolId: string;
  clientId: string;
  cognitoDomain: string;
  callbackUrl: string;
  authenticatedSmoke: boolean;
  allowUserSetup: boolean;
  allowTestDataWrites: boolean;
}

export function parseHostedTestRequest(args: string[], cdkDirectory: string): TestRequest {
  const [command, ...flags] = args;
  if (command !== "smoke" && command !== "hosted" && command !== "storage" && command !== "setup-users") {
    throw new Error("Choose smoke, hosted, storage or setup-users with --target test.");
  }
  const deploymentFlags: string[] = [];
  let outputsPath = join(cdkDirectory, "cdk-outputs.test.json");
  let allowWrites = false;
  let allowUserSetup = false;
  let authenticatedSmoke = false;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index];
    const value = flags[index + 1];
    if (!value || value.startsWith("--") || seen.has(key)) {
      throw new Error("Live-test options require a value and cannot be repeated.");
    }
    seen.add(key);
    if (key === "--outputs") {
      outputsPath = resolve(value);
    } else if (key === "--allow-test-data") {
      if (value !== "true" || (command !== "hosted" && command !== "storage")) {
        throw new Error("Use --allow-test-data true only for hosted or storage tests.");
      }
      allowWrites = true;
    } else if (key === "--allow-user-setup") {
      if (value !== "true" || command !== "setup-users") {
        throw new Error("Use --allow-user-setup true only with setup-users.");
      }
      allowUserSetup = true;
    } else if (key === "--authenticated") {
      if (value !== "true" || command !== "smoke") {
        throw new Error("Use --authenticated true only with smoke.");
      }
      authenticatedSmoke = true;
    } else {
      deploymentFlags.push(key, value);
    }
  }
  const deploymentCommand = command === "smoke" ? "synth" : "preflight";
  const deployment = parseDeploymentRequest([deploymentCommand, ...deploymentFlags]);
  if (deployment.target.name !== "test") {
    throw new Error("Live-test workflows accept only --target test; production is prohibited.");
  }
  if ((command === "hosted" || command === "storage") && (!allowWrites || !seen.has("--profile"))) {
    throw new Error("Data-writing tests require an explicit --profile and --allow-test-data true.");
  }
  if (command === "setup-users" && (!allowUserSetup || !seen.has("--profile"))) {
    throw new Error("User setup requires an explicit --profile and --allow-user-setup true.");
  }
  return { command, deployment, outputsPath, authenticatedSmoke };
}

export function loadHostedTestConfiguration(
  request: TestRequest, document: unknown
): HostedTestConfiguration {
  const target = request.deployment.target;
  if (!document || Object.keys(document).length !== 1) {
    throw new Error("Expected outputs for only InfraLensTestStack.");
  }
  // Reuse the existing account/region/stack/API/Cognito/origin validation.
  createFrontendConfigurations(target, document);
  const values = (document as Record<string, Record<string, string>>)[target.stackName];
  const resources = [
    [values.ProjectsTableName, /^InfraLensTestStack-ProjectsTable[A-Za-z0-9-]+$/],
    [values.RunsTableName, /^InfraLensTestStack-RunsTable[A-Za-z0-9-]+$/],
    [values.ArtifactBucketName, /^infralensteststack-artifactbucket[a-z0-9-]+$/]
  ] as const;
  if (resources.some(([value, pattern]) => !value || !pattern.test(value))) {
    throw new Error("Expected this test stack's generated history table and artifact bucket names.");
  }
  return {
    target: "test", account: target.account, region: target.region, stackName: target.stackName,
    profile: request.deployment.profile, apiBaseUrl: values.AnalysisApiBaseUrl,
    projectsTable: values.ProjectsTableName, runsTable: values.RunsTableName,
    artifactBucket: values.ArtifactBucketName, userPoolId: values.CognitoUserPoolId,
    clientId: values.CognitoWebClientId, cognitoDomain: values.CognitoHostedDomain,
    callbackUrl: "http://localhost:5173/auth/callback", authenticatedSmoke: request.authenticatedSmoke,
    allowUserSetup: request.command === "setup-users",
    allowTestDataWrites: request.command === "hosted" || request.command === "storage"
  };
}

export function runHostedTestWorkflow(
  args: string[], runner: ProcessRunner = runTestProcess,
  cdkDirectory = resolve(__dirname, ".."), inherited: NodeJS.ProcessEnv = process.env
): void {
  const request = parseHostedTestRequest(args, cdkDirectory);
  const legacyVariables = [
    "INFRALENS_DISPOSABLE_AWS", "INFRALENS_SMOKE_API_BASE_URL", "INFRALENS_TEST_API_URL",
    "INFRALENS_TEST_PROJECTS_TABLE", "INFRALENS_TEST_RUNS_TABLE", "INFRALENS_TEST_ARTIFACT_BUCKET",
    "INFRALENS_SMOKE_ACCESS_TOKEN", "INFRALENS_TEST_USER_A_TOKEN", "INFRALENS_TEST_USER_B_TOKEN"
  ];
  if (legacyVariables.some(name => inherited[name] !== undefined)) {
    throw new Error("Remove legacy live-test resource, opt-in and token variables; use deployment outputs, explicit flags and protected user credentials.");
  }
  const document: unknown = JSON.parse(readFileSync(request.outputsPath, "utf8").replace(/^\uFEFF/, ""));
  const configuration = loadHostedTestConfiguration(request, document);
  const environment = deploymentProcessEnvironment(request.deployment, inherited);
  for (const key of Object.keys(environment)) {
    if (/^INFRALENS_TEST_USER_[AB]_(EMAIL|PASSWORD)$/.test(key)) delete environment[key];
  }
  delete environment.INFRALENS_HOSTED_TEST_CONFIG;
  environment.INFRALENS_HOSTED_TEST_CONFIG = JSON.stringify(configuration);
  if (request.command !== "smoke") {
    const awsArgs = ["--profile", configuration.profile, "--region", configuration.region,
      "--output", "json", "--no-cli-pager"];
    const identity = runner({ executable: "aws", args: ["sts", "get-caller-identity", ...awsArgs],
      cwd: cdkDirectory, env: environment, capture: true });
    verifyCallerAccount(JSON.parse(identity), request.deployment.target);
    const response = runner({ executable: "aws", args: ["cloudformation", "describe-stacks",
      "--stack-name", configuration.stackName, ...awsArgs], cwd: cdkDirectory, env: environment, capture: true });
    const live = JSON.parse(response) as { Stacks?: Array<{
      StackId?: string; StackStatus?: string; Outputs?: Array<{ OutputKey: string; OutputValue: string }>;
    }> };
    const stack = live.Stacks?.[0];
    const expectedArn = `arn:aws:cloudformation:${configuration.region}:${configuration.account}:stack/${configuration.stackName}/`;
    if (live.Stacks?.length !== 1 || !stack?.StackId?.startsWith(expectedArn) ||
        !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus ?? "")) {
      throw new Error("The selected test application must exist with a stable deployment status.");
    }
    const actual = Object.fromEntries((stack.Outputs ?? []).map(item => [item.OutputKey, item.OutputValue]));
    const expected = (document as Record<string, Record<string, string>>)[configuration.stackName];
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) {
        throw new Error(`Deployment outputs are stale or mismatched (${key}); refresh test outputs before writing data.`);
      }
    }
  }
  const files: Record<TestCommand, string> = {
    smoke: "test/deployedRoutes.smoke.ts", hosted: "test/hostedHistory.hosted.ts", storage: "test/history.aws.ts",
    "setup-users": "test/testUserSetup.ts"
  };
  console.log(`Running ${request.command} checks for ${configuration.stackName} in ${configuration.region}.`);
  const workerArgs = request.command === "setup-users"
    ? ["-r", "ts-node/register", files[request.command]]
    : [require.resolve("mocha/bin/mocha.js"), "-r", "ts-node/register", files[request.command], "--timeout", "120000"];
  // Secrets are needed only by authentication/user setup workers, never AWS preflight or storage checks.
  const workerEnvironment = { ...environment };
  if (request.command === "hosted" || request.command === "setup-users" || request.authenticatedSmoke) {
    for (const key of Object.keys(inherited)) {
      if (/^INFRALENS_TEST_USER_[AB]_(EMAIL|PASSWORD)$/.test(key)) workerEnvironment[key] = inherited[key];
    }
  }
  runner({ executable: process.execPath,
    args: workerArgs,
    cwd: resolve(cdkDirectory, "../../apps/api"), env: workerEnvironment });
}

function runTestProcess(call: ProcessCall): string {
  const result = spawnSync(call.executable, call.args, {
    cwd: call.cwd, env: call.env, encoding: "utf8", shell: false,
    stdio: call.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Live-test process failed (exit ${result.status}). ${result.stderr ?? ""}`.trim());
  }
  return result.stdout ?? "";
}

if (require.main === module) {
  try {
    runHostedTestWorkflow(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Live-test workflow failed.");
    process.exitCode = 1;
  }
}
