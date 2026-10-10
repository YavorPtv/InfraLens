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

export function readHostedTestConfiguration(environment: NodeJS.ProcessEnv = process.env): HostedTestConfiguration {
  const input = environment.INFRALENS_HOSTED_TEST_CONFIG;
  if (!input) throw new Error("Use the guarded npm live-test commands with --target test and deployment outputs.");
  const config = JSON.parse(input) as HostedTestConfiguration;
  if (config.target !== "test" || config.account !== "230944684535" || config.region !== "eu-central-1" ||
      config.stackName !== "InfraLensTestStack" ||
      !/^https:\/\/[a-z0-9]+\.execute-api\.eu-central-1\.amazonaws\.com\/test\/$/.test(config.apiBaseUrl) ||
      !/^InfraLensTestStack-ProjectsTable[A-Za-z0-9-]+$/.test(config.projectsTable) ||
      !/^InfraLensTestStack-RunsTable[A-Za-z0-9-]+$/.test(config.runsTable) ||
      !/^infralensteststack-artifactbucket[a-z0-9-]+$/.test(config.artifactBucket) ||
      !/^eu-central-1_[A-Za-z0-9]+$/.test(config.userPoolId) || !/^[a-z0-9]+$/.test(config.clientId) ||
      config.cognitoDomain !== "https://infralens-test-230944684535-euc1.auth.eu-central-1.amazoncognito.com" ||
      config.callbackUrl !== "http://localhost:5173/auth/callback") {
    throw new Error("Live-test configuration must match the AWS test environment.");
  }
  return config;
}

export function requireTestDataWrites(config: HostedTestConfiguration): void {
  if (config.allowTestDataWrites !== true) {
    throw new Error("Writing temporary test data requires --allow-test-data true.");
  }
}

// Claim checks catch configuration mistakes; API Gateway verifies the signature and authorizes requests.
export function testAccessTokenSubject(
  token: string | undefined, config: HostedTestConfiguration, label: string, now = Date.now()
): string {
  const fail = () => new Error(`${label} must be a current test Cognito access token with openid scope.`);
  if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw fail();
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw fail();
  }
  if (!claims || claims.iss !== `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}` ||
      claims.client_id !== config.clientId || claims.token_use !== "access" ||
      typeof claims.exp !== "number" || claims.exp * 1000 <= now + 30_000 ||
      typeof claims.sub !== "string" || !claims.sub || typeof claims.scope !== "string" ||
      !claims.scope.split(" ").includes("openid")) {
    throw fail();
  }
  return claims.sub;
}

export function distinctTestUsers(
  first: string | undefined, second: string | undefined, config: HostedTestConfiguration, now = Date.now()
): void {
  const firstSubject = testAccessTokenSubject(first, config, "Test user A", now);
  const secondSubject = testAccessTokenSubject(second, config, "Test user B", now);
  if (firstSubject === secondSubject) throw new Error("Hosted isolation needs two different Cognito user subjects.");
}

export function hostedTestRequest(
  config: HostedTestConfiguration, path: string, options: RequestInit = {}, fetcher: typeof fetch = fetch
): Promise<Response> {
  if (path.startsWith("/") || path.includes(":") || path.includes("..")) {
    throw new Error("Use a relative test API path that preserves the selected stage.");
  }
  return fetcher(new URL(path, config.apiBaseUrl), {
    ...options, redirect: "error", signal: AbortSignal.timeout(10_000)
  });
}
