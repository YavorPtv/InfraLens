interface AuthConfig {
  clientId: string;
  cognitoDomain: string;
  redirectUri: string;
  logoutUri: string;
}

interface StoredTokens {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt: number;
}

interface CognitoTokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in: number;
}

const tokenStorageKey = "infralens.auth.tokens";
const verifierStorageKey = "infralens.auth.pkce_verifier";
const stateStorageKey = "infralens.auth.oauth_state";
const authChangedEvent = "infralens-auth-changed";
let callbackCompletion: Promise<void> | undefined;

export class AuthenticationRequiredError extends Error {
  constructor(message = "Your session has expired. Sign in again.") {
    super(message);
  }
}

export function isAuthenticationEnabled(): boolean {
  return import.meta.env.VITE_INFRALENS_AUTH_ENABLED === "true";
}

export function subscribeToAuthChanges(listener: () => void): () => void {
  window.addEventListener(authChangedEvent, listener);
  return () => window.removeEventListener(authChangedEvent, listener);
}

export async function hasAuthenticatedSession(): Promise<boolean> {
  if (!isAuthenticationEnabled()) {
    return true;
  }

  try {
    return (await getAccessToken()) !== undefined;
  } catch {
    return false;
  }
}

export async function beginSignIn(): Promise<void> {
  const config = getAuthConfig();
  const verifier = createRandomValue(64);
  const state = createRandomValue(24);
  const challenge = await createCodeChallenge(verifier);

  sessionStorage.setItem(verifierStorageKey, verifier);
  sessionStorage.setItem(stateStorageKey, state);

  const parameters = new URLSearchParams({
    client_id: config.clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email",
    state
  });

  window.location.assign(`${config.cognitoDomain}/oauth2/authorize?${parameters.toString()}`);
}

export async function completeSignIn(callbackUrl: string): Promise<void> {
  callbackCompletion ??= completeSignInOnce(callbackUrl);
  return callbackCompletion;
}

async function completeSignInOnce(callbackUrl: string): Promise<void> {
  const config = getAuthConfig();
  const url = new URL(callbackUrl);
  const error = url.searchParams.get("error");
  if (error !== null) {
    throw new AuthenticationRequiredError(
      url.searchParams.get("error_description") ?? "Cognito sign-in was not completed."
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = sessionStorage.getItem(stateStorageKey);
  const verifier = sessionStorage.getItem(verifierStorageKey);
  if (code === null || state === null || state !== expectedState || verifier === null) {
    clearAuthSession();
    throw new AuthenticationRequiredError("The sign-in response could not be verified.");
  }

  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri
    })
  });

  if (!response.ok) {
    clearAuthSession();
    throw new AuthenticationRequiredError("Cognito could not complete sign-in.");
  }

  storeTokens((await response.json()) as CognitoTokenResponse);
  sessionStorage.removeItem(verifierStorageKey);
  sessionStorage.removeItem(stateStorageKey);
  notifyAuthChanged();
}

export function beginSignOut(): void {
  const config = getAuthConfig();
  clearAuthSession();
  const parameters = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: config.logoutUri
  });
  window.location.assign(`${config.cognitoDomain}/logout?${parameters.toString()}`);
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);

  if (isAuthenticationEnabled()) {
    const accessToken = await getAccessToken();
    if (accessToken === undefined) {
      clearAuthSession();
      throw new AuthenticationRequiredError();
    }

    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 || response.status === 403) {
    clearAuthSession();
    throw new AuthenticationRequiredError();
  }

  return response;
}

function getAuthConfig(): AuthConfig {
  if (!isAuthenticationEnabled()) {
    throw new Error("InfraLens authentication is not enabled.");
  }

  const clientId = import.meta.env.VITE_INFRALENS_COGNITO_CLIENT_ID;
  const cognitoDomain = import.meta.env.VITE_INFRALENS_COGNITO_DOMAIN;
  const redirectUri =
    import.meta.env.VITE_INFRALENS_COGNITO_REDIRECT_URI ??
    `${window.location.origin}/auth/callback`;
  const logoutUri =
    import.meta.env.VITE_INFRALENS_COGNITO_LOGOUT_URI ?? `${window.location.origin}/`;

  if (clientId === undefined || cognitoDomain === undefined) {
    throw new Error("Cognito client ID and domain are required when authentication is enabled.");
  }

  return {
    clientId,
    cognitoDomain: cognitoDomain.replace(/\/+$/, ""),
    redirectUri,
    logoutUri
  };
}

async function getAccessToken(): Promise<string | undefined> {
  const tokens = readTokens();
  if (tokens === undefined) {
    return undefined;
  }

  if (tokens.expiresAt > Date.now() + 60_000) {
    return tokens.accessToken;
  }

  if (tokens.refreshToken === undefined) {
    return undefined;
  }

  return refreshAccessToken(tokens.refreshToken);
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const config = getAuthConfig();
  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  if (!response.ok) {
    clearAuthSession();
    throw new AuthenticationRequiredError();
  }

  const refreshed = (await response.json()) as CognitoTokenResponse;
  storeTokens({ ...refreshed, refresh_token: refreshToken });
  return refreshed.access_token;
}

function storeTokens(tokens: CognitoTokenResponse): void {
  const storedTokens: StoredTokens = {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    ...(tokens.id_token === undefined ? {} : { idToken: tokens.id_token }),
    ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token })
  };
  sessionStorage.setItem(tokenStorageKey, JSON.stringify(storedTokens));
}

function readTokens(): StoredTokens | undefined {
  const rawTokens = sessionStorage.getItem(tokenStorageKey);
  if (rawTokens === null) {
    return undefined;
  }

  try {
    const tokens = JSON.parse(rawTokens) as Partial<StoredTokens>;
    return typeof tokens.accessToken === "string" && typeof tokens.expiresAt === "number"
      ? (tokens as StoredTokens)
      : undefined;
  } catch {
    return undefined;
  }
}

function clearAuthSession(): void {
  sessionStorage.removeItem(tokenStorageKey);
  sessionStorage.removeItem(verifierStorageKey);
  sessionStorage.removeItem(stateStorageKey);
  notifyAuthChanged();
}

function notifyAuthChanged(): void {
  window.dispatchEvent(new Event(authChangedEvent));
}

function createRandomValue(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return toBase64Url(bytes);
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

function toBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
