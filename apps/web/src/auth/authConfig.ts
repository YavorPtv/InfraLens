export interface AuthConfig {
  clientId: string;
  cognitoDomain: string;
  redirectUri: string;
  logoutUri: string;
}

export function validateFrontendMode(mode: string, environment: Record<string, string | undefined>): void {
  if (mode.startsWith("aws-")) {
    const supportedModes: Record<string, string> = {
      "aws-test-local": "test",
      "aws-test-hosted": "test",
      "aws-production-hosted": "production"
    };
    const target = supportedModes[mode];
    if (!target || environment.VITE_INFRALENS_DEPLOYMENT_TARGET !== target) {
      throw new Error(`Mode ${mode} requires its matching generated deployment configuration. Run frontend-config after deployment.`);
    }
    const localOrigin = environment.VITE_INFRALENS_FRONTEND_ORIGIN === "http://localhost:5173";
    if (localOrigin !== (mode === "aws-test-local")) {
      throw new Error(`Frontend origin does not match mode ${mode}.`);
    }
  }
  resolveAuthConfig(environment);
}

/** Shared by Vite validation and the browser; runtime development mode selects no AWS target. */
export function resolveAuthConfig(
  environment: Record<string, string | undefined>,
  browserOrigin?: string
): AuthConfig | undefined {
  const api = new URL(environment.VITE_INFRALENS_API_BASE_URL || "http://localhost:3000");
  const localApi = api.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname);
  const target = environment.VITE_INFRALENS_DEPLOYMENT_TARGET;
  const enabled = environment.VITE_INFRALENS_AUTH_ENABLED === "true";
  if (!target && localApi && !enabled) {
    return undefined;
  }
  if (target !== "test" && target !== "production") {
    throw new Error("A hosted API requires VITE_INFRALENS_DEPLOYMENT_TARGET=test or production.");
  }
  if (!enabled) {
    throw new Error("Cognito authentication must be enabled for a hosted API.");
  }
  if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash ||
      !/^[a-z0-9]+\.execute-api\.eu-central-1\.amazonaws\.com$/.test(api.hostname) ||
      api.port || api.pathname.replace(/\/$/, "") !== `/${target}`) {
    throw new Error("API URL must match the selected AWS target and configured region.");
  }
  const clientId = environment.VITE_INFRALENS_COGNITO_CLIENT_ID;
  const cognitoDomain = environment.VITE_INFRALENS_COGNITO_DOMAIN;
  const prefix = target === "test" ? "infralens-test-230944684535-euc1" : "infralens-prod-609124256824-euc1";
  if (!clientId || !/^[a-z0-9]+$/.test(clientId) ||
      cognitoDomain !== `https://${prefix}.auth.eu-central-1.amazoncognito.com`) {
    throw new Error("Cognito client and domain must match the selected target's deployment outputs.");
  }
  const origin = environment.VITE_INFRALENS_FRONTEND_ORIGIN;
  if (!origin) {
    throw new Error("VITE_INFRALENS_FRONTEND_ORIGIN is required for a hosted API.");
  }
  const url = new URL(origin);
  const localTestFrontend = target === "test" && origin === "http://localhost:5173";
  if (url.origin !== origin || (!localTestFrontend &&
      (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      origin.includes("*") || (browserOrigin !== undefined && browserOrigin !== origin)) {
    throw new Error("The frontend origin must match this build's configured environment.");
  }
  const redirectUri = environment.VITE_INFRALENS_COGNITO_REDIRECT_URI;
  const logoutUri = environment.VITE_INFRALENS_COGNITO_LOGOUT_URI;
  if (redirectUri !== `${origin}/auth/callback` || logoutUri !== `${origin}/`) {
    throw new Error("Cognito callback and logout URLs must match the configured frontend origin.");
  }
  return { clientId, cognitoDomain, redirectUri, logoutUri };
}

export function authSessionStorageKey(config: AuthConfig, suffix: string): string {
  return `infralens.auth.${config.cognitoDomain}.${config.clientId}.${suffix}`;
}
