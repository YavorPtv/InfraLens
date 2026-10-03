export type DeploymentTargetName = "test" | "production";

export interface DeploymentTarget {
  name: DeploymentTargetName;
  account: string;
  region: string;
  stackName: string;
  profile: string;
  regionConfirmed: boolean;
  cognitoDomainPrefix: string;
  additionalFrontendOrigins: readonly string[];
  runtimeEnvironment: "production";
  pointInTimeRecovery: boolean;
}

// Deployment identity is deliberately independent of process.env and application runtime mode.
const targets: Record<DeploymentTargetName, DeploymentTarget> = {
  test: {
    name: "test",
    account: "230944684535",
    region: "eu-central-1",
    stackName: "InfraLensTestStack",
    profile: "infralens-test-admin",
    regionConfirmed: true,
    cognitoDomainPrefix: "infralens-test-230944684535-euc1",
    additionalFrontendOrigins: ["http://localhost:5173"],
    runtimeEnvironment: "production",
    pointInTimeRecovery: false
  },
  production: {
    name: "production",
    account: "609124256824",
    region: "eu-central-1",
    stackName: "InfraLensProdStack",
    profile: "infralens-prod-admin",
    regionConfirmed: false,
    cognitoDomainPrefix: "infralens-prod-609124256824-euc1",
    additionalFrontendOrigins: [],
    runtimeEnvironment: "production",
    pointInTimeRecovery: true
  }
};

export function resolveDeploymentTarget(value: unknown): DeploymentTarget {
  if (value !== "test" && value !== "production") {
    throw new Error("An explicit deployment target is required: target=test or target=production.");
  }
  const target = { ...targets[value], additionalFrontendOrigins: [...targets[value].additionalFrontendOrigins] };
  validateDeploymentTarget(target);
  return target;
}

export function validateDeploymentTarget(target: DeploymentTarget): void {
  const expected = targets[target.name];
  if (!expected || target.account !== expected.account || target.region !== expected.region ||
      target.stackName !== expected.stackName) {
    throw new Error("Deployment target account, region, and stack must match the configured target.");
  }
  if (target.runtimeEnvironment !== "production") {
    throw new Error("Hosted targets require production runtime safeguards.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(target.cognitoDomainPrefix) ||
      /aws|amazon|cognito/.test(target.cognitoDomainPrefix)) {
    throw new Error("Invalid Cognito domain prefix; use lowercase letters, numbers and internal hyphens without aws, amazon, or cognito.");
  }
  for (const origin of target.additionalFrontendOrigins) {
    const url = new URL(origin);
    const localTestOrigin = target.name === "test" && origin === "http://localhost:5173";
    if (url.origin !== origin || origin.includes("*") ||
        (!localTestOrigin && (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error("Frontend origins must be exact HTTPS origins; only test permits http://localhost:5173.");
    }
  }
}

export function frontendUrls(origins: readonly string[]) {
  return {
    callbackUrls: origins.map((origin) => `${origin}/auth/callback`),
    logoutUrls: origins.map((origin) => `${origin}/`)
  };
}
