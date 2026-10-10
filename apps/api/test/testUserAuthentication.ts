import { createHash, randomBytes } from "node:crypto";
import { chromium, type Browser, type Page, type Request, type Response as BrowserResponse } from "playwright";
import { distinctTestUsers, readHostedTestConfiguration, testAccessTokenSubject, type HostedTestConfiguration } from "./hostedTestHelpers";
import { readTestUserCredentials, type TestUser, type TestUserCredentials } from "./testUserCredentials";

interface AuthorizationRequest {
  url: string;
  state: string;
  verifier: string;
  callbackUrl: string;
}
interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}
export type BrowserAuthorization = (request: AuthorizationRequest, user: TestUserCredentials) => Promise<string>;

type SignInOutcome = { callbackUrl: string } | { failure: string };

export async function readCallbackRedirect(response: BrowserResponse, request: AuthorizationRequest): Promise<SignInOutcome | undefined> {
  const source = new URL(response.url());
  if (source.origin !== new URL(request.url).origin || ![301, 302, 303, 307, 308].includes(response.status())) {
    return undefined;
  }
  try {
    const location = await response.headerValue("location");
    if (!location) return undefined;
    const destination = new URL(location, source);
    const expected = new URL(request.callbackUrl);
    if (destination.origin !== expected.origin || destination.pathname !== expected.pathname) return undefined;
    // Location contains a secret authorization code. Keep it in memory and validate before use.
    try {
      authorizationCode(destination.toString(), request);
      return { callbackUrl: destination.toString() };
    } catch {
      return { failure: "callback-validation" };
    }
  } catch {
    return { failure: "callback-header" };
  }
}

interface SignInProgress {
  loginPosts: number;
  loginStatus: number | null;
  loginRequestFailed: boolean;
  failedRequests: number;
  scriptErrors: number;
}

function isLoginPost(request: Request, origin: string): boolean {
  const url = new URL(request.url());
  return request.method() === "POST" && url.origin === origin && url.pathname === "/login";
}

function trackSignInProgress(page: Page, origin: string): SignInProgress {
  const progress: SignInProgress = { loginPosts: 0, loginStatus: null, loginRequestFailed: false, failedRequests: 0, scriptErrors: 0 };
  page.on("request", request => {
    if (isLoginPost(request, origin)) progress.loginPosts++;
  });
  page.on("response", response => {
    if (isLoginPost(response.request(), origin)) progress.loginStatus = response.status();
  });
  page.on("requestfailed", request => {
    progress.failedRequests++;
    if (isLoginPost(request, origin)) progress.loginRequestFailed = true;
  });
  page.on("pageerror", () => { progress.scriptErrors++; });
  return progress;
}

async function signInDiagnosticSummary(page: Page, request: AuthorizationRequest, progress: SignInProgress): Promise<string> {
  const current = new URL(page.url());
  const cognitoOrigin = new URL(request.url).origin;
  const callback = new URL(request.callbackUrl);
  let pageCategory = "other-origin";
  if (current.origin === cognitoOrigin) {
    const paths = ["/login", "/error", "/mfa", "/newPassword", "/forgotPassword", "/confirmUser"];
    pageCategory = paths.includes(current.pathname) ? `cognito${current.pathname}` : "cognito-other-page";
  } else if (current.origin === callback.origin && current.pathname === callback.pathname) {
    pageCategory = "callback";
  }
  try {
    const validity = await page.evaluate(() => {
      const password = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="password"]'))
        .find(input => input.getClientRects().length > 0);
      const email = password?.form?.querySelector<HTMLInputElement>('input[name="username"]');
      return {
        passwordFormPresent: Boolean(password?.form),
        emailInvalid: Boolean(email && !email.validity.valid),
        passwordInvalid: Boolean(password && !password.validity.valid)
      };
    });
    return `Safe diagnostics: ${JSON.stringify({ ...progress, page: pageCategory,
      passwordFormPresent: validity.passwordFormPresent === true,
      emailInvalid: validity.emailInvalid === true, passwordInvalid: validity.passwordInvalid === true })}`;
  } catch {
    return `Safe diagnostics: ${JSON.stringify({ ...progress, page: pageCategory, formInspection: "unavailable" })}`;
  }
}

export function cognitoSignInFailureMessage(code: string): string {
  switch (code) {
    case "credentials":
      return "Cognito rejected the email/password. Reload the saved credentials; user setup preserves existing confirmed passwords.";
    case "attempts":
      return "Cognito reported too many failed password attempts. Stop retrying and check the saved credentials.";
    case "reset":
      return "Cognito requires a password reset; complete that administrative operation separately.";
    case "new-password":
      return "Cognito requires a new permanent password; complete the dedicated test-user setup.";
    case "mfa":
      return "Cognito presented an MFA challenge; this automation supports the configured password-only test pool.";
    case "csrf":
      return "Cognito rejected the login request or CSRF session; check the login flow and browser session.";
    case "callback-validation":
      return "Cognito's callback redirect failed URL, state or authorization-code validation.";
    case "callback-header":
      return "The Cognito redirect header could not be read safely.";
    case "page-inspection":
      return "The Cognito rejection check failed to execute; inspect the safe browser diagnostics.";
    default:
      return "No callback or recognized Cognito rejection arrived before the timeout. No page text or URL was logged.";
  }
}

type SignInStage = "launching Chromium" | "creating the browser context" | "opening the Cognito sign-in page" |
  "checking the sign-in origin" | "locating the password sign-in form" | "filling the email field" |
  "filling the password field" | "submitting the sign-in form" | "waiting for the OAuth callback";

function signInFailureDetail(stage: SignInStage, error: unknown, pageStatus?: number): string {
  // Classify known failures without copying Playwright's call log, URLs or filled input values.
  const message = error instanceof Error ? error.message : "";
  if (stage === "launching Chromium" && message.includes("Executable doesn't exist")) {
    return "Chromium is missing. Run npx.cmd playwright install chromium in the repository root.";
  }
  if (stage === "opening the Cognito sign-in page" && pageStatus && pageStatus >= 400) {
    return `The sign-in page returned HTTP ${pageStatus}. Check Cognito domain/client availability.`;
  }
  if (stage === "checking the sign-in origin") {
    return "Cognito redirected outside the expected sign-in origin. Check the OAuth client and registered callback configuration.";
  }
  if (message.includes("strict mode violation")) {
    return "Multiple matching sign-in controls were found; the Cognito form selector needs review.";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    if (stage === "waiting for the OAuth callback") {
      return "The callback timed out. Check the saved credentials and that the test user is CONFIRMED; MFA/password challenges need separate support.";
    }
    return "The browser operation timed out. Check Cognito page availability and the password sign-in controls.";
  }
  return "Check Chromium, the Cognito password sign-in form and the saved credentials; no raw browser diagnostics were logged.";
}

export function createAuthorizationRequest(configuration: HostedTestConfiguration): AuthorizationRequest {
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const url = new URL("/oauth2/authorize", configuration.cognitoDomain);
  url.search = new URLSearchParams({
    client_id: configuration.clientId, redirect_uri: configuration.callbackUrl,
    response_type: "code", scope: "openid email", state,
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url")
  }).toString();
  return { url: url.toString(), state, verifier, callbackUrl: configuration.callbackUrl };
}

export function authorizationCode(callback: string, request: AuthorizationRequest): string {
  const url = new URL(callback);
  const expected = new URL(request.callbackUrl);
  const code = url.searchParams.get("code");
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash ||
      url.searchParams.get("state") !== request.state || url.searchParams.has("error") || !code) {
    throw new Error("Test sign-in returned an invalid OAuth callback or state.");
  }
  return code;
}

export async function authorizeInBrowser(
  request: AuthorizationRequest, user: TestUserCredentials,
  launch: () => Promise<Browser> = () => chromium.launch({ headless: true })
): Promise<string> {
  let browser: Browser | undefined;
  let stage: SignInStage = "launching Chromium";
  let pageStatus: number | undefined;
  let rejectionDetail: string | undefined;
  try {
    browser = await launch();
    stage = "creating the browser context";
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    const progress = trackSignInProgress(page, new URL(request.url).origin);
    let finishSignIn!: (outcome: SignInOutcome) => void;
    const callback = new Promise<SignInOutcome>(resolve => { finishSignIn = resolve; });
    // page.route only intercepts the first URL in a redirect chain, not its callback destination.
    // Observe Cognito's redirect response instead; no localhost server or callback page load is needed.
    page.on("response", response => {
      void readCallbackRedirect(response, request).then(outcome => {
        if (outcome) finishSignIn(outcome);
      }).catch(() => { finishSignIn({ failure: "callback-header" }); });
    });
    stage = "opening the Cognito sign-in page";
    const response = await page.goto(request.url, { waitUntil: "domcontentloaded" });
    pageStatus = response?.status();
    if (pageStatus && pageStatus >= 400) {
      throw new Error("Cognito sign-in page returned an unsuccessful HTTP status.");
    }
    stage = "checking the sign-in origin";
    if (new URL(page.url()).origin !== new URL(request.url).origin) {
      throw new Error("Unexpected sign-in origin.");
    }
    stage = "locating the password sign-in form";
    // Classic Cognito serves desktop/mobile copies. Keep email/password/submit in the same form.
    const form = page.locator("form:visible").filter({
      has: page.locator('input[name="password"]:visible')
    }).first();
    await form.waitFor({ state: "visible", timeout: 15_000 });
    stage = "filling the email field";
    await form.locator('input[name="username"]:visible').fill(user.email);
    stage = "filling the password field";
    await form.locator('input[name="password"]:visible').fill(user.password);
    stage = "submitting the sign-in form";
    // Classic Cognito displays "Sign in", but aria-label="submit" overrides that accessible name.
    await form.locator('input[name="signInSubmitButton"]:visible').click({ noWaitAfter: true });
    stage = "waiting for the OAuth callback";
    // Return only a fixed failure code from the page. Never transfer its text or filled input values.
    const rejection: Promise<SignInOutcome> = page.waitForFunction(() => {
      const text = (document.body?.innerText ?? "").toLowerCase();
      if (text.includes("password attempts exceeded") || text.includes("too many failed attempts")) return "attempts";
      if (text.includes("incorrect username or password") || text.includes("user does not exist") || text.includes("user is disabled")) return "credentials";
      if (text.includes("password reset required")) return "reset";
      if (document.querySelector('input[name="newPassword"]')) return "new-password";
      if (document.querySelector('input[name="mfaCode"], input[name="totpCode"]')) return "mfa";
      if (text.includes("invalid csrf") || text.includes("invalid request")) return "csrf";
      return false;
    }, undefined, { polling: 100, timeout: 45_000 }).then(async result => {
      try {
        return { failure: String(await result.jsonValue()) };
      } finally {
        await result.dispose();
      }
    }).catch(error => ({ failure: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "page-inspection" }));
    const outcome = await Promise.race([callback, rejection]);
    if ("callbackUrl" in outcome) return outcome.callbackUrl;
    rejectionDetail = cognitoSignInFailureMessage(outcome.failure);
    if (outcome.failure === "timeout" || outcome.failure === "page-inspection") {
      rejectionDetail += ` ${await signInDiagnosticSummary(page, request, progress)}`;
    }
    throw new Error("Cognito sign-in did not complete.");
  } catch (error) {
    // Browser diagnostics can contain filled passwords, emails or authorization codes.
    throw new Error(`Test user ${user.label} OAuth sign-in failed while ${stage}. ${rejectionDetail ?? signInFailureDetail(stage, error, pageStatus)}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        throw new Error("Test authentication browser cleanup failed; no browser diagnostics were logged.");
      }
    }
  }
}

function maskSecret(value: string): void {
  if (process.env.GITHUB_ACTIONS === "true") {
    const escaped = value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    process.stdout.write(`::add-mask::${escaped}\n`);
  }
}

export class TestUserAuthentication {
  private readonly tokens = new Map<TestUser, Tokens>();
  private readonly subjects = new Map<TestUser, string>();
  private readonly pending = new Map<TestUser, Promise<string>>();

  constructor(
    private readonly configuration: HostedTestConfiguration,
    private readonly users = readTestUserCredentials(),
    private readonly authorize: BrowserAuthorization = authorizeInBrowser,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {
    readHostedTestConfiguration({ INFRALENS_HOSTED_TEST_CONFIG: JSON.stringify(configuration) });
  }

  async accessToken(label: TestUser): Promise<string> {
    const cached = this.tokens.get(label);
    if (cached && cached.expiresAt > this.now() + 60_000) return cached.accessToken;
    const pending = this.pending.get(label);
    if (pending) return pending;
    const acquisition = this.acquire(label);
    this.pending.set(label, acquisition);
    try {
      return await acquisition;
    } finally {
      this.pending.delete(label);
    }
  }

  async assertDistinctUsers(): Promise<void> {
    const first = await this.accessToken("A");
    const second = await this.accessToken("B");
    distinctTestUsers(first, second, this.configuration, this.now());
  }

  clear(): void {
    this.tokens.clear();
    this.subjects.clear();
  }

  private async acquire(label: TestUser): Promise<string> {
    const user = this.users.find(item => item.label === label);
    if (!user) throw new Error(`Missing test user ${label} credentials.`);
    const cached = this.tokens.get(label);
    let tokens: Tokens | undefined;
    if (cached?.refreshToken) {
      tokens = await this.exchange(new URLSearchParams({
        grant_type: "refresh_token", client_id: this.configuration.clientId, refresh_token: cached.refreshToken
      }), cached.refreshToken);
    }
    if (!tokens) {
      const request = createAuthorizationRequest(this.configuration);
      const callback = await this.authorize(request, user);
      const code = authorizationCode(callback, request);
      tokens = await this.exchange(new URLSearchParams({
        grant_type: "authorization_code", client_id: this.configuration.clientId,
        redirect_uri: request.callbackUrl, code_verifier: request.verifier, code
      }));
    }
    if (!tokens) throw new Error(`Test user ${label} OAuth code exchange failed.`);
    const subject = testAccessTokenSubject(tokens.accessToken, this.configuration, `Test user ${label}`, this.now());
    const previous = this.subjects.get(label);
    if (previous && previous !== subject) throw new Error("Test authentication changed user identity during a run.");
    this.subjects.set(label, subject);
    this.tokens.set(label, tokens);
    return tokens.accessToken;
  }

  private async exchange(form: URLSearchParams, previousRefreshToken?: string): Promise<Tokens | undefined> {
    let response: Response;
    try {
      response = await this.fetcher(new URL("/oauth2/token", this.configuration.cognitoDomain), {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(), redirect: "error", signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new Error("Test OAuth token endpoint is unavailable; no request details were logged.");
    }
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      if (previousRefreshToken && response.status === 400 && result.error === "invalid_grant") return undefined;
      throw new Error("Test OAuth token endpoint rejected authentication; no response details were logged.");
    }
    if (typeof result.access_token !== "string" || typeof result.expires_in !== "number" ||
        !Number.isFinite(result.expires_in) || result.expires_in <= 60 || result.token_type !== "Bearer" ||
        (result.refresh_token !== undefined && typeof result.refresh_token !== "string")) {
      throw new Error("Test OAuth endpoint returned an invalid token response.");
    }
    testAccessTokenSubject(result.access_token, this.configuration, "OAuth response", this.now());
    for (const name of ["access_token", "refresh_token", "id_token"]) {
      if (typeof result[name] === "string") maskSecret(result[name]);
    }
    const claims = JSON.parse(Buffer.from(result.access_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return {
      accessToken: result.access_token,
      refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : previousRefreshToken,
      expiresAt: Math.min(this.now() + result.expires_in * 1000, (claims.exp ?? 0) * 1000)
    };
  }
}
