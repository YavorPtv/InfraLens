import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { frontendUrls, resolveDeploymentTarget, type DeploymentTarget } from "./deployment-target";

type Command = "synth" | "preflight" | "diff" | "deploy" | "frontend-config";
export interface DeploymentRequest {
  command: Command;
  target: DeploymentTarget;
  profile: string;
  region?: string;
  stack?: string;
  confirmedProductionRegion?: string;
}

export function parseDeploymentRequest(args: string[]): DeploymentRequest {
  const [command, ...flags] = args;
  if (!["synth", "preflight", "diff", "deploy", "frontend-config"].includes(command)) {
    throw new Error("Use synth, preflight, diff, deploy, or frontend-config with --target test|production.");
  }
  const options: Record<string, string> = {};
  const allowed = ["--target", "--profile", "--region", "--stack", "--confirm-production-region"];
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index];
    const value = flags[index + 1];
    if (!allowed.includes(key) || !value || value.startsWith("--") || options[key] !== undefined) {
      throw new Error(`Invalid or duplicate deployment option: ${key}. Options use --name value.`);
    }
    options[key] = value;
  }
  const target = resolveDeploymentTarget(options["--target"]);
  const profile = options["--profile"] ?? target.profile;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(profile)) {
    throw new Error("Invalid AWS profile name.");
  }
  const request: DeploymentRequest = {
    command: command as Command,
    target,
    profile,
    region: options["--region"],
    stack: options["--stack"],
    confirmedProductionRegion: options["--confirm-production-region"]
  };
  validateIntendedDeployment(request);
  return request;
}

export function validateIntendedDeployment(request: DeploymentRequest): void {
  const { target, region, stack } = request;
  const online = ["preflight", "diff", "deploy"].includes(request.command);
  if ((online || region !== undefined) && region !== target.region) {
    throw new Error(`Expected --region ${target.region} for ${target.name}; received ${region ?? "no region"}.`);
  }
  if ((online || stack !== undefined) && stack !== target.stackName) {
    throw new Error(`Expected --stack ${target.stackName} for ${target.name}; received ${stack ?? "no stack"}.`);
  }
  if (online && !target.regionConfirmed && request.confirmedProductionRegion !== target.region) {
    throw new Error(`Production region is proposed, not confirmed. Confirm the decision with --confirm-production-region ${target.region} before online operations.`);
  }
}

export function verifyCallerAccount(identity: unknown, target: DeploymentTarget): void {
  const account = (identity as { Account?: unknown } | null)?.Account;
  if (account !== target.account) {
    throw new Error(`AWS caller account mismatch: ${target.name} requires ${target.account}, received ${String(account)}. No CDK operation was started.`);
  }
}

export interface ProcessCall {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  capture?: boolean;
}
export type ProcessRunner = (call: ProcessCall) => string;

export function deploymentProcessEnvironment(
  request: DeploymentRequest,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    // Clear ambient keys, role overrides, endpoints, and CDK identity/context variables.
    if (!/^(AWS_|CDK_|AMAZON_REGION$)/i.test(key)) {
      environment[key] = value;
    }
  }
  environment.AWS_EC2_METADATA_DISABLED = "true";
  if (["preflight", "diff", "deploy"].includes(request.command)) {
    environment.AWS_PROFILE = request.profile;
    environment.AWS_REGION = request.target.region;
    environment.AWS_DEFAULT_REGION = request.target.region;
    environment.AWS_SDK_LOAD_CONFIG = "1";
  }
  return environment;
}

export function deploymentPaths(target: DeploymentTarget, cdkDirectory: string) {
  return {
    assembly: join(cdkDirectory, "cdk.out", target.name),
    outputs: join(cdkDirectory, `cdk-outputs.${target.name}.json`)
  };
}

export function runDeploymentWorkflow(
  args: string[],
  runner: ProcessRunner = runProcess,
  cdkDirectory = resolve(__dirname, "..")
): void {
  const request = parseDeploymentRequest(args);
  const { target } = request;
  const paths = deploymentPaths(target, cdkDirectory);
  const environment = deploymentProcessEnvironment(request);
  if (request.command === "frontend-config") {
    const document: unknown = JSON.parse(readFileSync(paths.outputs, "utf8"));
    const configs = createFrontendConfigurations(target, document);
    const webDirectory = resolve(cdkDirectory, "../../apps/web");
    for (const [mode, content] of Object.entries(configs)) {
      writeFileSync(join(webDirectory, `.env.${mode}.local`), content);
    }
    console.log(`Wrote frontend configuration for ${target.name}: ${Object.keys(configs).join(", ")}`);
    return;
  }
  if (request.command !== "synth") {
    const awsArgs = ["--profile", request.profile, "--region", target.region, "--no-cli-pager", "--output", "json"];
    const identity = runner({
      executable: "aws", args: ["sts", "get-caller-identity", ...awsArgs],
      cwd: cdkDirectory, env: environment, capture: true
    });
    verifyCallerAccount(JSON.parse(identity), target);
    const bootstrap = JSON.parse(runner({
      executable: "aws", args: ["cloudformation", "describe-stacks", "--stack-name", "CDKToolkit", ...awsArgs],
      cwd: cdkDirectory, env: environment, capture: true
    })) as { Stacks?: Array<{ StackId?: string; StackStatus?: string }> };
    const stack = bootstrap.Stacks?.[0];
    const bootstrapArn = `arn:aws:cloudformation:${target.region}:${target.account}:stack/CDKToolkit/`;
    if (!stack?.StackId?.startsWith(bootstrapArn) ||
        !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus ?? "")) {
      throw new Error("CDKToolkit must exist in the selected account/region with a stable status. Review bootstrap setup separately; this command never bootstraps.");
    }
    console.log(`Preflight passed: ${target.name}, ${target.account}, ${target.region}, ${target.stackName}, profile ${request.profile}.`);
    if (request.command === "preflight") {
      return;
    }
  }

  mkdirSync(paths.assembly, { recursive: true });
  runner({
    executable: process.execPath,
    args: [join(cdkDirectory, "dist/index.js")],
    cwd: cdkDirectory,
    env: {
      ...deploymentProcessEnvironment({ ...request, command: "synth" }),
      CDK_OUTDIR: paths.assembly,
      CDK_CONTEXT_JSON: JSON.stringify({ target: target.name })
    }
  });
  const manifest: unknown = JSON.parse(readFileSync(join(paths.assembly, "manifest.json"), "utf8"));
  verifyAssembly(manifest, target);
  if (request.command === "synth") {
    console.log(`Offline synthesis: ${paths.assembly}`);
    return;
  }
  const cdkArgs = [
    require.resolve("aws-cdk/bin/cdk"), request.command, target.stackName,
    "--app", paths.assembly, "--profile", request.profile,
    "--no-lookups", "--exclusively", "--no-notices", "--no-telemetry"
  ];
  if (request.command === "diff") {
    // A normal CDK diff can create change sets or publish assets. Template mode does neither.
    cdkArgs.push("--method", "template");
  } else {
    cdkArgs.push("--outputs-file", paths.outputs, "--require-approval", "broadening");
  }
  runner({ executable: process.execPath, args: cdkArgs, cwd: cdkDirectory, env: environment });
}

export function verifyAssembly(document: unknown, target: DeploymentTarget): void {
  const assembly = document as {
    missing?: unknown[];
    artifacts?: Record<string, { type?: string; environment?: string; properties?: { stackName?: string } }>;
  };
  const stacks = Object.entries(assembly.artifacts ?? {}).filter(([, artifact]) => artifact.type === "aws:cloudformation:stack");
  // CDK omits properties.stackName when the artifact ID is also the deployed stack name.
  if (assembly.missing?.length || stacks.length !== 1 || stacks[0][0] !== target.stackName ||
      stacks[0][1].environment !== `aws://${target.account}/${target.region}` ||
      (stacks[0][1].properties?.stackName ?? stacks[0][0]) !== target.stackName) {
    throw new Error("Synthesized assembly must contain only the selected account, region, and application stack, without lookups.");
  }
}

export function createFrontendConfigurations(target: DeploymentTarget, document: unknown): Record<string, string> {
  const values = (document as Record<string, Record<string, string>> | null)?.[target.stackName];
  if (!values || values.DeploymentAccount !== target.account || values.DeploymentRegion !== target.region ||
      values.DeploymentStackName !== target.stackName || values.DeploymentEnvironment !== target.name) {
    throw new Error("Deployment outputs do not match the selected target.");
  }
  const origin = values.FrontendOrigin;
  if (!/^https:\/\/[a-z0-9]+\.cloudfront\.net$/.test(origin)) {
    throw new Error("Expected the deployed CloudFront frontend origin.");
  }
  const origins = [origin, ...target.additionalFrontendOrigins];
  const urls = frontendUrls(origins);
  if (values.AllowedFrontendOrigins !== origins.join(",") ||
      values.CognitoCallbackUrls !== urls.callbackUrls.join(",") ||
      values.CognitoLogoutUrls !== urls.logoutUrls.join(",")) {
    throw new Error("Frontend origins and Cognito URLs in outputs do not match the target configuration.");
  }
  const apiPattern = new RegExp(`^https://[a-z0-9]+\\.execute-api\\.${target.region}\\.amazonaws\\.com/${target.name}/$`);
  const expectedDomain = `https://${target.cognitoDomainPrefix}.auth.${target.region}.amazoncognito.com`;
  if (!apiPattern.test(values.AnalysisApiBaseUrl) || values.CognitoHostedDomain !== expectedDomain ||
      !/^[a-z0-9]+$/.test(values.CognitoWebClientId ?? "") ||
      !values.CognitoUserPoolId?.startsWith(`${target.region}_`)) {
    throw new Error("Invalid API or Cognito deployment outputs.");
  }
  const configurations: Record<string, string> = {};
  for (const frontendOrigin of origins) {
    const kind = frontendOrigin === origin ? "hosted" : "local";
    const mode = `aws-${target.name}-${kind}`;
    configurations[mode] = [
      `VITE_INFRALENS_DEPLOYMENT_TARGET=${target.name}`,
      `VITE_INFRALENS_API_BASE_URL=${values.AnalysisApiBaseUrl}`,
      "VITE_INFRALENS_AUTH_ENABLED=true",
      `VITE_INFRALENS_COGNITO_CLIENT_ID=${values.CognitoWebClientId}`,
      `VITE_INFRALENS_COGNITO_DOMAIN=${values.CognitoHostedDomain}`,
      `VITE_INFRALENS_FRONTEND_ORIGIN=${frontendOrigin}`,
      `VITE_INFRALENS_COGNITO_REDIRECT_URI=${frontendOrigin}/auth/callback`,
      `VITE_INFRALENS_COGNITO_LOGOUT_URI=${frontendOrigin}/`,
      ""
    ].join("\n");
  }
  return configurations;
}

function runProcess(call: ProcessCall): string {
  const result = spawnSync(call.executable, call.args, {
    cwd: call.cwd, env: call.env, encoding: "utf8", shell: false,
    stdio: call.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${call.executable} failed (exit ${result.status}). ${result.stderr ?? ""}`.trim());
  }
  return result.stdout ?? "";
}

if (require.main === module) {
  try {
    runDeploymentWorkflow(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
