import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createFrontendConfigurations, deploymentProcessEnvironment, parseDeploymentRequest,
  runProcess, verifyCallerAccount, type DeploymentRequest, type ProcessRunner
} from "./deployment-workflow";
import type { PolicyDocument } from "./test-permissions";

interface FrontendOutputs {
  values: Record<string, string>;
  configurations: Record<string, string>;
  bucket: string;
  distributionId: string;
  origin: string;
}

function readFrontendOutputs(request: DeploymentRequest, document: unknown): FrontendOutputs {
  if (request.target.name !== "test") {
    throw new Error("Frontend publishing workflows accept only --target test; production is prohibited.");
  }
  if (!document || Object.keys(document).length !== 1) {
    throw new Error("Expected outputs for only InfraLensTestStack.");
  }
  const configurations = createFrontendConfigurations(request.target, document);
  const values = (document as Record<string, Record<string, string>>)[request.target.stackName];
  if (!/^infralensteststack-frontendbucket[a-z0-9-]+$/.test(values.FrontendBucketName ?? "") ||
      !/^E[A-Z0-9]+$/.test(values.FrontendDistributionId ?? "") ||
      values.FrontendOrigin !== `https://${values.FrontendDistributionDomainName}`) {
    throw new Error("Expected this test stack's frontend bucket, distribution ID and CloudFront domain.");
  }
  return { values, configurations, bucket: values.FrontendBucketName,
    distributionId: values.FrontendDistributionId, origin: values.FrontendOrigin };
}

export function createTestFrontendPolicy(targetName: string, document: unknown): PolicyDocument {
  const request = parseDeploymentRequest(["synth", "--target", targetName]);
  const frontend = readFrontendOutputs(request, document);
  const target = request.target;
  const bucketArn = `arn:aws:s3:::${frontend.bucket}`;
  const regionalBucket = { "aws:RequestedRegion": target.region, "s3:ResourceAccount": target.account };
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "VerifyCallerIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
      { Sid: "ReadTestStackOutputs", Effect: "Allow", Action: ["cloudformation:DescribeStacks"],
        Resource: `arn:aws:cloudformation:${target.region}:${target.account}:stack/${target.stackName}/*`,
        Condition: { StringEquals: { "aws:RequestedRegion": target.region } } },
      { Sid: "CheckFrontendBucketRegion", Effect: "Allow", Action: ["s3:GetBucketLocation"],
        Resource: bucketArn, Condition: { StringEquals: regionalBucket } },
      { Sid: "UploadFrontendFiles", Effect: "Allow", Action: ["s3:PutObject"],
        Resource: `${bucketArn}/*`,
        Condition: { StringEquals: { ...regionalBucket, "s3:x-amz-server-side-encryption": "AES256" } } },
      // CloudFront is global; its requests must not be constrained to eu-central-1.
      { Sid: "CheckAndRefreshTestDistribution", Effect: "Allow",
        Action: ["cloudfront:GetDistribution", "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
        Resource: `arn:aws:cloudfront::${target.account}:distribution/${frontend.distributionId}` }
    ]
  };
}

function assertBuildDirectory(webDirectory: string): string {
  const directory = join(webDirectory, "dist", "aws-test");
  // Vite empties its output directory. Refuse links/junctions before starting that operation.
  for (const path of [join(webDirectory, "dist"), directory]) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) {
      throw new Error("The test frontend build directory must be a real directory inside apps/web/dist.");
    }
  }
  return directory;
}

function buildFrontend(
  request: DeploymentRequest, frontend: FrontendOutputs, runner: ProcessRunner,
  cdkDirectory: string, inherited: NodeJS.ProcessEnv
): string {
  const webDirectory = resolve(cdkDirectory, "../../apps/web");
  const buildDirectory = assertBuildDirectory(webDirectory);
  const environment = deploymentProcessEnvironment({ ...request, command: "synth" }, inherited);
  environment.NODE_ENV = "production";
  for (const key of Object.keys(environment)) {
    if (/^(VITE_|INFRALENS_TEST_USER_|INFRALENS_HOSTED_TEST_CONFIG$)/i.test(key)) delete environment[key];
  }
  for (const [mode, contents] of Object.entries(frontend.configurations)) {
    writeFileSync(join(webDirectory, `.env.${mode}.local`), contents, "utf8");
  }
  // Process variables override .env files in Vite. Pin every consumed setting to validated outputs.
  for (const line of frontend.configurations["aws-test-hosted"].split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const viteCli = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  runner({ executable: process.execPath, args: [viteCli, "build", "--mode", "aws-test-hosted",
    "--outDir", "dist/aws-test", "--emptyOutDir"], cwd: webDirectory, env: environment });
  assertBuildDirectory(webDirectory);
  return buildDirectory;
}

function buildFiles(directory: string): string[] {
  const files: string[] = [];
  function visit(path: string, prefix: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Frontend upload must not follow symbolic links.");
      if (entry.isDirectory()) visit(join(path, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error("Frontend build contains an unsupported filesystem entry.");
    }
  }
  visit(directory, "");
  const index = files.indexOf("index.html");
  if (index < 0 || lstatSync(join(directory, "index.html")).size === 0 || !files.some(path => path.startsWith("assets/"))) {
    throw new Error("A fresh hosted frontend build must contain index.html and its assets before upload.");
  }
  files.splice(index, 1);
  return [...files.sort(), "index.html"];
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    html: "text/html", js: "application/javascript", css: "text/css", json: "application/json",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    ico: "image/x-icon", txt: "text/plain", woff: "font/woff", woff2: "font/woff2"
  };
  return types[path.split(".").pop() ?? ""] ?? "application/octet-stream";
}

function verifyLiveFrontend(
  request: DeploymentRequest, frontend: FrontendOutputs, runner: ProcessRunner,
  cdkDirectory: string, environment: NodeJS.ProcessEnv
): void {
  const target = request.target;
  const common = ["--profile", request.profile, "--region", target.region, "--output", "json", "--no-cli-pager"];
  function inspect<T>(args: string[]): T {
    return JSON.parse(runner({ executable: "aws", args: [...args, ...common],
      cwd: cdkDirectory, env: environment, capture: true })) as T;
  }
  verifyCallerAccount(inspect<unknown>(["sts", "get-caller-identity"]), target);
  const response = inspect<{ Stacks?: Array<{
    StackId?: string; StackStatus?: string; Outputs?: Array<{ OutputKey: string; OutputValue: string }>;
  }> }>(["cloudformation", "describe-stacks", "--stack-name", target.stackName]);
  const stack = response.Stacks?.[0];
  const expectedArn = `arn:aws:cloudformation:${target.region}:${target.account}:stack/${target.stackName}/`;
  if (response.Stacks?.length !== 1 || !stack?.StackId?.startsWith(expectedArn) ||
      !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus ?? "")) {
    throw new Error("Expected the exact test application stack in a stable deployment status before publishing.");
  }
  const outputs = Object.fromEntries((stack.Outputs ?? []).map((value: { OutputKey: string; OutputValue: string }) =>
    [value.OutputKey, value.OutputValue]));
  for (const [key, value] of Object.entries(frontend.values)) {
    if (outputs[key] !== value) throw new Error(`Deployment outputs are stale or mismatched (${key}); publishing blocked.`);
  }
  const location = inspect<{ LocationConstraint?: string }>(["s3api", "get-bucket-location", "--bucket", frontend.bucket,
    "--expected-bucket-owner", target.account]);
  if (location.LocationConstraint !== target.region) throw new Error("Frontend bucket region does not match test.");
  const distribution = inspect<{ Distribution?: {
    ARN?: string; Id?: string; Status?: string; DomainName?: string;
    DistributionConfig?: { Enabled?: boolean; DefaultRootObject?: string;
      Origins?: { Items?: Array<{ DomainName: string; OriginAccessControlId?: string; OriginPath?: string }> } };
  } }>(["cloudfront", "get-distribution", "--id", frontend.distributionId]).Distribution;
  const origins = distribution?.DistributionConfig?.Origins?.Items;
  const expectedOrigins = [`${frontend.bucket}.s3.${target.region}.amazonaws.com`, `${frontend.bucket}.s3.amazonaws.com`];
  if (distribution?.ARN !== `arn:aws:cloudfront::${target.account}:distribution/${frontend.distributionId}` ||
      distribution.Id !== frontend.distributionId || distribution.Status !== "Deployed" ||
      `https://${distribution.DomainName}` !== frontend.origin || distribution.DistributionConfig?.Enabled !== true ||
      distribution.DistributionConfig.DefaultRootObject !== "index.html" || origins?.length !== 1 ||
      !expectedOrigins.includes(origins[0].DomainName) || !origins[0].OriginAccessControlId || origins[0].OriginPath) {
    throw new Error("Live CloudFront distribution must serve this test frontend bucket through origin access control.");
  }
}

export function runTestFrontendWorkflow(
  args: string[], runner: ProcessRunner = runProcess,
  cdkDirectory = resolve(__dirname, ".."), inherited: NodeJS.ProcessEnv = process.env
): void {
  const [command, ...flags] = args;
  if (!["permissions", "build", "publish"].includes(command)) {
    throw new Error("Choose permissions, build or publish with --target test.");
  }
  // Reuse explicit deployment account/region/stack validation. Publishing requires all three flags.
  const request = parseDeploymentRequest([command === "publish" ? "preflight" : "synth", ...flags]);
  if (request.target.name !== "test") {
    throw new Error("Frontend publishing workflows accept only --target test; production is prohibited.");
  }
  if (command !== "publish" && flags.some(flag => flag === "--profile" || flag === "--confirm-production-region")) {
    throw new Error("Offline frontend preparation does not accept a profile or production confirmation.");
  }
  if (command === "publish" && !flags.includes("--profile")) throw new Error("Publishing requires an explicit --profile.");
  const document: unknown = JSON.parse(readFileSync(join(cdkDirectory, "cdk-outputs.test.json"), "utf8").replace(/^\uFEFF/, ""));
  const frontend = readFrontendOutputs(request, document);
  if (command === "permissions") {
    const path = join(cdkDirectory, "cdk.out", "test-frontend.policy.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(createTestFrontendPolicy(request.target.name, document), null, 2)}\n`, "utf8");
    console.log(`Prepared frontend inline policy: ${path}. Nothing was applied to AWS.`);
    return;
  }
  const environment = deploymentProcessEnvironment(request, inherited);
  for (const key of Object.keys(environment)) {
    if (/^(VITE_|INFRALENS_TEST_USER_|INFRALENS_HOSTED_TEST_CONFIG$)/i.test(key)) delete environment[key];
  }
  if (command === "publish") verifyLiveFrontend(request, frontend, runner, cdkDirectory, environment);
  const directory = buildFrontend(request, frontend, runner, cdkDirectory, inherited);
  const files = buildFiles(directory);
  if (command === "build") {
    console.log(`Built test frontend offline: ${directory}. Hosted URL: ${frontend.origin}`);
    return;
  }
  const common = ["--profile", request.profile, "--region", request.target.region, "--output", "json", "--no-cli-pager"];
  // Upload hashed assets before the entry page, preserving old assets used by existing browser tabs.
  for (const file of files) {
    runner({ executable: "aws", args: ["s3api", "put-object", "--bucket", frontend.bucket,
      "--key", file, "--body", join(directory, file), "--content-type", contentType(file),
      "--cache-control", file.startsWith("assets/") && /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(file)
        ? "public,max-age=31536000,immutable" : "no-cache,max-age=0,must-revalidate",
      "--server-side-encryption", "AES256", "--expected-bucket-owner", request.target.account, ...common],
      cwd: cdkDirectory, env: environment, capture: true });
  }
  const response = JSON.parse(runner({ executable: "aws", args: ["cloudfront", "create-invalidation",
    "--distribution-id", frontend.distributionId, "--paths", "/*", ...common],
    cwd: cdkDirectory, env: environment, capture: true }));
  const invalidationId = response.Invalidation?.Id;
  if (typeof invalidationId !== "string" || !/^[A-Z0-9]+$/.test(invalidationId)) {
    throw new Error("Files uploaded, but CloudFront returned an invalid invalidation ID; review cache refresh separately.");
  }
  runner({ executable: "aws", args: ["cloudfront", "wait", "invalidation-completed", "--distribution-id",
    frontend.distributionId, "--id", invalidationId, ...common], cwd: cdkDirectory, env: environment });
  console.log(`Published test frontend: ${frontend.origin}. CloudFront invalidation completed.`);
}

if (require.main === module) {
  try {
    runTestFrontendWorkflow(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Test frontend workflow failed.");
    process.exitCode = 1;
  }
}
