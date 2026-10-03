import { authSessionStorageKey, resolveAuthConfig, type AuthConfig } from "./authConfig";

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

const authChangedEvent = "infralens-auth-changed";
let callbackCompletion: Promise<void> | undefined;

export class AuthenticationRequiredError extends Error {
  constructor(message = "Your session has expired. Sign in again.") {
    super(message);
  }
}

export function isAuthenticationEnabled(): boolean {
  return resolveAuthConfig(import.meta.env, window.location.origin) !== undefined;
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

  sessionStorage.setItem(storageKey("pkce_verifier"), verifier);
  sessionStorage.setItem(storageKey("oauth_state"), state);

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
  const expectedState = sessionStorage.getItem(storageKey("oauth_state"));
  const verifier = sessionStorage.getItem(storageKey("pkce_verifier"));
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
  sessionStorage.removeItem(storageKey("pkce_verifier"));
  sessionStorage.removeItem(storageKey("oauth_state"));
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
  const config = resolveAuthConfig(import.meta.env, window.location.origin);
  if (config === undefined) {
    throw new Error("InfraLens authentication is not enabled.");
  }
  return config;
}

function storageKey(suffix: string): string {
  return authSessionStorageKey(getAuthConfig(), suffix);
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
  sessionStorage.setItem(storageKey("tokens"), JSON.stringify(storedTokens));
}

function readTokens(): StoredTokens | undefined {
  const rawTokens = sessionStorage.getItem(storageKey("tokens"));
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
  if (!isAuthenticationEnabled()) {
    return;
  }
  sessionStorage.removeItem(storageKey("tokens"));
  sessionStorage.removeItem(storageKey("pkce_verifier"));
  sessionStorage.removeItem(storageKey("oauth_state"));
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
