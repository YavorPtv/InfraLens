import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect } from "chai";
import type { Browser, Response as BrowserResponse } from "playwright";
import { AdminCreateUserCommand, AdminGetUserCommand, AdminSetUserPasswordCommand } from "@aws-sdk/client-cognito-identity-provider";
import type { HostedTestConfiguration } from "./hostedTestHelpers";
import { authorizationCode, authorizeInBrowser, cognitoSignInFailureMessage, createAuthorizationRequest, readCallbackRedirect, TestUserAuthentication } from "./testUserAuthentication";
import { readTestUserCredentials, type TestUserCredentials } from "./testUserCredentials";
import { provisionTestUsers } from "./testUserSetup";

const configuration: HostedTestConfiguration = {
  target: "test", account: "230944684535", region: "eu-central-1", stackName: "InfraLensTestStack",
  profile: "test-setup", apiBaseUrl: "https://example.execute-api.eu-central-1.amazonaws.com/test/",
  projectsTable: "InfraLensTestStack-ProjectsTableABC-example", runsTable: "InfraLensTestStack-RunsTableABC-example",
  artifactBucket: "infralensteststack-artifactbucketabc-example", userPoolId: "eu-central-1_example",
  clientId: "exampleclient", allowTestDataWrites: false, allowUserSetup: true, authenticatedSmoke: true,
  cognitoDomain: "https://infralens-test-230944684535-euc1.auth.eu-central-1.amazoncognito.com",
  callbackUrl: "http://localhost:5173/auth/callback"
};
const credentials = {
  INFRALENS_TEST_USER_A_EMAIL: "fixture-a@example.com", INFRALENS_TEST_USER_A_PASSWORD: "Fixture-A-password-123!",
  INFRALENS_TEST_USER_B_EMAIL: "fixture-b@example.com", INFRALENS_TEST_USER_B_PASSWORD: "Fixture-B-password-123!"
};
const users = readTestUserCredentials(credentials);
const start = 1_800_000_000_000;
function accessToken(user: TestUserCredentials, now: number, overrides: Record<string, unknown> = {}): string {
  const payload = {
    iss: `https://cognito-idp.${configuration.region}.amazonaws.com/${configuration.userPoolId}`,
    client_id: configuration.clientId, token_use: "access", scope: "openid email",
    username: user.username, sub: `subject-${user.label}`, exp: now / 1000 + 300, ...overrides
  };
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
}
function tokenResponse(token: string, refreshToken?: string): Response {
  return Response.json({ access_token: token, expires_in: 300, token_type: "Bearer", refresh_token: refreshToken });
}
function callback(request: ReturnType<typeof createAuthorizationRequest>): string {
  return `${request.callbackUrl}?code=fixture-code&state=${request.state}`;
}
async function rejects(action: () => Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try { await action(); } catch (error) { failure = error; }
  expect(failure).to.be.instanceOf(Error);
  expect((failure as Error).message).to.include(message);
}

describe("test-user credentials and persistent setup (offline)", () => {
  it("requires both users' protected credentials and different emails without exposing passwords", () => {
    expect(() => readTestUserCredentials({})).to.throw("protected secrets");
    expect(() => readTestUserCredentials({ ...credentials, INFRALENS_TEST_USER_A_PASSWORD: "short" })).to.throw("12 characters");
    expect(() => readTestUserCredentials({ ...credentials, INFRALENS_TEST_USER_B_EMAIL: credentials.INFRALENS_TEST_USER_A_EMAIL }))
      .to.throw("different dedicated email");
    expect(users.map(user => user.username)).to.deep.equal(["fixture-a@example.com", "fixture-b@example.com"]);
  });

  it("requires test-only setup opt-in before sending Cognito commands", async () => {
    for (const override of [{ allowUserSetup: false }, { account: "609124256824" }, { stackName: "InfraLensProdStack" }]) {
      let calls = 0;
      await rejects(() => provisionTestUsers({ ...configuration, ...override }, users, async () => { calls++; }),
        override.allowUserSetup === false ? "guarded" : "test environment");
      expect(calls).to.equal(0);
    }
  });

  function existing(user: TestUserCredentials, status = "CONFIRMED") {
    return { Enabled: true, UserStatus: status, UserAttributes: [
      { Name: "email", Value: user.email }, { Name: "email_verified", Value: "true" },
      { Name: "name", Value: `InfraLens automated test user ${user.label}` }
    ] };
  }

  it("creates missing users without invitations and sets permanent passwords only once", async () => {
    const calls: Array<AdminGetUserCommand | AdminCreateUserCommand | AdminSetUserPasswordCommand> = [];
    const stored = new Map<string, ReturnType<typeof existing>>();
    const send = async (command: typeof calls[number]) => {
      calls.push(command);
      if (command instanceof AdminGetUserCommand) {
        const user = stored.get(command.input.Username!);
        if (user) return user;
        throw Object.assign(new Error("missing fixture"), { name: "UserNotFoundException" });
      }
      if (command instanceof AdminCreateUserCommand) {
        expect(command.input.MessageAction).to.equal("SUPPRESS");
        expect(command.input.ForceAliasCreation).to.equal(false);
        stored.set(command.input.Username!, existing(users.find(user => user.username === command.input.Username)!, "FORCE_CHANGE_PASSWORD"));
      } else {
        expect(command.input.Permanent).to.equal(true);
        stored.get(command.input.Username!)!.UserStatus = "CONFIRMED";
      }
      expect(command.input.UserPoolId).to.equal(configuration.userPoolId);
      return {};
    };
    await provisionTestUsers(configuration, users, send);
    expect(calls.map(command => command.constructor.name)).to.deep.equal([
      "AdminGetUserCommand", "AdminGetUserCommand", "AdminCreateUserCommand", "AdminSetUserPasswordCommand",
      "AdminCreateUserCommand", "AdminSetUserPasswordCommand"
    ]);
    calls.length = 0;
    await provisionTestUsers(configuration, users, send);
    expect(calls.every(command => command instanceof AdminGetUserCommand)).to.equal(true);
    expect(calls).to.have.length(2);
  });

  it("resumes an interrupted setup without recreating the user", async () => {
    const calls: string[] = [];
    await provisionTestUsers(configuration, users, async command => {
      calls.push(command.constructor.name);
      if (command instanceof AdminGetUserCommand) {
        return existing(users.find(user => user.username === command.input.Username)!,
          command.input.Username === users[0].username ? "FORCE_CHANGE_PASSWORD" : "CONFIRMED");
      }
      return {};
    });
    expect(calls).to.deep.equal(["AdminGetUserCommand", "AdminGetUserCommand", "AdminSetUserPasswordCommand"]);
  });

  it("refuses unrelated users or permission failures before writes", async () => {
    for (const failure of ["foreign", "denied"]) {
      let writes = 0;
      await rejects(() => provisionTestUsers(configuration, users, async command => {
        if (!(command instanceof AdminGetUserCommand)) { writes++; return {}; }
        if (failure === "denied") throw new Error("Access denied");
        return { ...existing(users[0]), UserAttributes: [{ Name: "email", Value: "another@example.com" }] };
      }), failure === "denied" ? "Access denied" : "unexpected attributes");
      expect(writes).to.equal(0);
    }
  });
});

describe("automatic OAuth test authentication (offline)", () => {
  it("uses PKCE S256, app scopes, random state and the exact registered test callback", () => {
    const request = createAuthorizationRequest(configuration);
    const url = new URL(request.url);
    expect(url.origin).to.equal(configuration.cognitoDomain);
    expect(url.pathname).to.equal("/oauth2/authorize");
    expect(url.searchParams.get("scope")).to.equal("openid email");
    expect(url.searchParams.get("code_challenge_method")).to.equal("S256");
    expect(url.searchParams.get("code_challenge")).to.equal(createHash("sha256").update(request.verifier).digest("base64url"));
    expect(url.searchParams.get("redirect_uri")).to.equal(configuration.callbackUrl);
    expect(createAuthorizationRequest(configuration).state).not.to.equal(request.state);
    expect(authorizationCode(callback(request), request)).to.equal("fixture-code");
    for (const invalid of [callback(request).replace(request.state, "wrong"), callback(request).replace("localhost", "otherhost"),
      callback(request).replace("/auth/callback", "/wrong"), `${callback(request)}&error=access_denied`]) {
      expect(() => authorizationCode(invalid, request)).to.throw("callback or state");
    }
  });

  it("deduplicates login, caches tokens and refreshes before expiry on demand", async () => {
    let now = start;
    let logins = 0;
    const forms: URLSearchParams[] = [];
    const provider = new TestUserAuthentication(configuration, users, async request => {
      logins++; return callback(request);
    }, async (url, options) => {
      expect(String(url)).to.equal(`${configuration.cognitoDomain}/oauth2/token`);
      expect(options?.redirect).to.equal("error");
      const form = new URLSearchParams(String(options?.body));
      forms.push(form);
      return tokenResponse(accessToken(users[0], now), form.get("grant_type") === "authorization_code" ? "fixture-refresh" : undefined);
    }, () => now);
    const [first, second] = await Promise.all([provider.accessToken("A"), provider.accessToken("A")]);
    expect(first).to.equal(second);
    expect(await provider.accessToken("A")).to.equal(first);
    expect(logins).to.equal(1);
    expect(forms).to.have.length(1);
    expect(forms[0].get("code_verifier")).to.have.length(64);
    now += 250_000;
    expect(await provider.accessToken("A")).not.to.equal(first);
    expect(forms[1].get("grant_type")).to.equal("refresh_token");
    expect(forms[1].get("refresh_token")).to.equal("fixture-refresh");
    now += 250_000;
    await provider.accessToken("A");
    expect(forms[2].get("refresh_token")).to.equal("fixture-refresh");
    expect(logins).to.equal(1);
    provider.clear();
    await provider.accessToken("A");
    expect(logins).to.equal(2);
  });

  it("reauthenticates when refresh is revoked, but fails on other errors without logging details", async () => {
    for (const code of ["invalid_grant", "server_error"]) {
      let now = start;
      let logins = 0;
      const provider = new TestUserAuthentication(configuration, users, async request => {
        logins++; return callback(request);
      }, async (_url, options) => {
        const form = new URLSearchParams(String(options?.body));
        if (form.get("grant_type") === "refresh_token") return Response.json({ error: code, secret: "must-not-log" }, { status: 400 });
        return tokenResponse(accessToken(users[0], now), "fixture-refresh");
      }, () => now);
      await provider.accessToken("A");
      now += 250_000;
      if (code === "invalid_grant") {
        await provider.accessToken("A");
        expect(logins).to.equal(2);
      } else {
        await rejects(() => provider.accessToken("A"), "no response details");
        expect(logins).to.equal(1);
      }
    }
  });

  it("rejects wrong-client, expired, missing-scope tokens and a changed user after refresh", async () => {
    for (const override of [{ client_id: "productionclient" }, { exp: start / 1000 }, { scope: "email" }]) {
      const provider = new TestUserAuthentication(configuration, users, async request => callback(request),
        async () => tokenResponse(accessToken(users[0], start, override)), () => start);
      await rejects(() => provider.accessToken("A"), "current test Cognito access token");
    }
    let now = start;
    const provider = new TestUserAuthentication(configuration, users, async request => callback(request),
      async () => tokenResponse(accessToken(users[0], now, { sub: now === start ? "original" : "different" }), "fixture-refresh"), () => now);
    await provider.accessToken("A");
    now += 250_000;
    await rejects(() => provider.accessToken("A"), "changed user identity");
  });

  it("rejects same-subject users even when their token strings differ", async () => {
    let current = users[0];
    const provider = new TestUserAuthentication(configuration, users, async (request, user) => {
      current = user; return callback(request);
    }, async () => tokenResponse(accessToken(current, start, { sub: "same" })), () => start);
    await rejects(() => provider.assertDistinctUsers(), "different Cognito user subjects");
  });

  it("captures a Cognito 302 Location when redirect destinations are not routed and localhost fails", async () => {
    const request = createAuthorizationRequest(configuration);
    const filled: Record<string, string> = {};
    let currentUrl = request.url;
    let closed = 0;
    let submitted = false;
    const responseHandlers: Array<(response: BrowserResponse) => void> = [];
    // Public classic Cognito HTML: visible value differs from the accessible name.
    const submitControl = { name: "signInSubmitButton", value: "Sign in", ariaLabel: "submit" };
    const form = {
      waitFor: async () => {},
      locator: (selector: string) => {
        if (selector === `input[name="${submitControl.name}"]:visible`) {
          return { click: async (options: { noWaitAfter?: boolean }) => {
            expect(options.noWaitAfter).to.equal(true);
            submitted = true;
            const response = {
              url: () => `${configuration.cognitoDomain}/login`, status: () => 302,
              request: () => ({ url: () => `${configuration.cognitoDomain}/login`, method: () => "POST" }),
              headerValue: async (name: string) => {
                expect(name).to.equal("location");
                return callback(request);
              }
            } as unknown as BrowserResponse;
            for (const handler of responseHandlers) handler(response);
            currentUrl = "chrome-error://chromewebdata/";
          } };
        }
        return { fill: async (value: string) => { filled[selector] = value; } };
      },
      getByRole: (_role: string, options: { name: RegExp }) => ({ click: async () => {
        if (!options.name.test(submitControl.ariaLabel)) {
          throw Object.assign(new Error("No matching accessible button name"), { name: "TimeoutError" });
        }
        submitted = true;
        currentUrl = callback(request);
      } })
    };
    const fake = {
      newContext: async () => ({ newPage: async () => ({
        setDefaultTimeout: () => {},
        on: (name: string, handler: (response: BrowserResponse) => void) => {
          if (name === "response") responseHandlers.push(handler);
        },
        route: async () => { throw new Error("Callback route cannot intercept redirect destinations"); },
        goto: async (url: string) => { currentUrl = url; }, url: () => currentUrl,
        locator: (selector: string) => {
          if (selector === "form:visible") return { filter: () => ({ first: () => form }) };
          return {};
        },
        getByRole: () => { throw new Error("Unscoped submit matches both Cognito forms"); },
        waitForFunction: async () => new Promise(() => {})
      }) }),
      close: async () => { closed++; }
    } as unknown as Browser;
    expect(await authorizeInBrowser(request, users[0], async () => fake)).to.equal(callback(request));
    expect(closed).to.equal(1);
    expect(submitted).to.equal(true);
    expect(currentUrl).to.equal("chrome-error://chromewebdata/");
    expect(filled['input[name="password"]:visible']).to.equal(users[0].password);
  });

  it("identifies a missing Chromium installation without exposing the browser call log", async () => {
    const secret = `${users[0].password} authorization-code-secret`;
    try {
      await authorizeInBrowser(createAuthorizationRequest(configuration), users[0], async () => {
        throw new Error(`Executable doesn't exist. ${secret}`);
      });
      expect.fail("Missing Chromium should reject");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).to.include("while launching Chromium");
      expect(message).to.include("npx.cmd playwright install chromium");
      expect(message).not.to.include(secret);
    }
  });

  it("accepts redirects only from test Cognito to the exact callback with a valid code and state", async () => {
    const request = createAuthorizationRequest(configuration);
    function response(source: string, location: string, status = 302): BrowserResponse {
      return { url: () => source, status: () => status, headerValue: async () => location } as unknown as BrowserResponse;
    }
    const source = `${configuration.cognitoDomain}/login`;
    expect(await readCallbackRedirect(response("https://foreign.example/login", callback(request)), request)).to.equal(undefined);
    expect(await readCallbackRedirect(response(source, callback(request), 200), request)).to.equal(undefined);
    expect(await readCallbackRedirect(response(source, callback(request).replace("localhost", "foreignhost")), request)).to.equal(undefined);
    expect(await readCallbackRedirect(response(source, callback(request).replace("/auth/callback", "/other")), request)).to.equal(undefined);
    for (const invalid of [callback(request).replace(request.state, "wrong"),
      `${request.callbackUrl}?state=${request.state}`, `${callback(request)}&error=access_denied`]) {
      expect(await readCallbackRedirect(response(source, invalid), request)).to.deep.equal({ failure: "callback-validation" });
    }
    expect(await readCallbackRedirect(response(source, callback(request)), request)).to.deep.equal({ callbackUrl: callback(request) });
  });

  it("reports callback timeouts and still closes the browser without leaking URLs or filled values", async () => {
    let closed = 0;
    const handlers = new Map<string, Array<(event: unknown) => void>>();
    const loginPost = {
      url: () => `${configuration.cognitoDomain}/login?code=private-code&password=${users[0].password}`,
      method: () => "POST"
    };
    const form = {
      waitFor: async () => {}, locator: () => ({ fill: async () => {}, click: async () => {
        for (const handler of handlers.get("request")!) handler(loginPost);
        for (const handler of handlers.get("response")!) {
          handler({ request: () => loginPost, url: () => loginPost.url(), status: () => 200 });
        }
      } })
    };
    const request = createAuthorizationRequest(configuration);
    const fake = {
      newContext: async () => ({ newPage: async () => ({
        setDefaultTimeout: () => {}, route: async () => {}, goto: async () => {},
        url: () => `${configuration.cognitoDomain}/login?code=private-code`,
        on: (name: string, handler: (event: unknown) => void) => {
          const listeners = handlers.get(name) ?? [];
          listeners.push(handler);
          handlers.set(name, listeners);
        },
        evaluate: async () => ({ passwordFormPresent: true, emailInvalid: false, passwordInvalid: false,
          privateValue: users[0].password }),
        locator: (selector: string) => selector === "form:visible"
          ? { filter: () => ({ first: () => form }) } : {},
        waitForFunction: async () => {
          throw Object.assign(new Error(`${users[0].password} ${request.url}&code=secret-code`), { name: "TimeoutError" });
        }
      }) }), close: async () => { closed++; }
    } as unknown as Browser;
    try {
      await authorizeInBrowser(request, users[0], async () => fake);
      expect.fail("Missing callback should reject");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).to.include("waiting for the OAuth callback");
      expect(message).to.include("No callback or recognized Cognito rejection");
      expect(message).to.include('"loginPosts":1');
      expect(message).to.include('"loginStatus":200');
      expect(message).to.include('"page":"cognito/login"');
      expect(message).not.to.include(users[0].password);
      expect(message).not.to.include(request.url);
      expect(message).not.to.include("secret-code");
      expect(message).not.to.include("private-code");
      expect(message).not.to.include("privateValue");
    }
    expect(closed).to.equal(1);
  });

  it("reports an allowlisted Cognito credential rejection immediately and sanitizes unknown codes", async () => {
    let closed = 0;
    const request = createAuthorizationRequest(configuration);
    const form = { waitFor: async () => {}, locator: () => ({ fill: async () => {}, click: async () => {} }) };
    const fake = {
      newContext: async () => ({ newPage: async () => ({
        setDefaultTimeout: () => {}, route: async () => {}, goto: async () => {}, url: () => request.url,
        on: () => {},
        locator: (selector: string) => selector === "form:visible" ? { filter: () => ({ first: () => form }) } : {},
        waitForFunction: async (readPage: () => unknown) => {
          // Execute the browser classifier offline against a private-text fixture, without a browser.
          const code = runInNewContext(`(${readPage.toString()})()`, {
            document: {
              body: { innerText: `Incorrect username or password. ${users[0].email} ${users[0].password}` },
              querySelector: () => null
            }
          });
          expect(code).to.equal("credentials");
          return { jsonValue: async () => code, dispose: async () => {} };
        }
      }) }), close: async () => { closed++; }
    } as unknown as Browser;
    await rejects(() => authorizeInBrowser(request, users[0], async () => fake), "Cognito rejected the email/password");
    expect(closed).to.equal(1);
    expect(cognitoSignInFailureMessage(users[0].password)).not.to.include(users[0].password);
    expect(cognitoSignInFailureMessage("new-password")).to.include("permanent password");
    expect(cognitoSignInFailureMessage("mfa")).to.include("MFA challenge");
    expect(cognitoSignInFailureMessage("attempts")).to.include("Stop retrying");
  });

  it("sanitizes browser failures containing passwords and codes", async () => {
    try {
      await authorizeInBrowser(createAuthorizationRequest(configuration), users[0], async () => {
        throw new Error(users[0].password);
      });
      expect.fail("Browser failure should reject");
    } catch (error) {
      expect((error as Error).message).to.include("OAuth sign-in failed");
      expect((error as Error).message).not.to.include(users[0].password);
    }
  });

  it("refuses a foreign sign-in origin before filling credentials and closes the browser", async () => {
    let closed = 0;
    let filled = false;
    const fake = {
      newContext: async () => ({ newPage: async () => ({
        setDefaultTimeout: () => {}, route: async () => {}, goto: async () => {},
        on: () => {},
        url: () => "https://foreign.example/login",
        locator: () => { filled = true; throw new Error("Must not fill credentials"); }
      }) }), close: async () => { closed++; }
    } as unknown as Browser;
    await rejects(() => authorizeInBrowser(createAuthorizationRequest(configuration), users[0], async () => fake), "OAuth sign-in failed");
    expect(filled).to.equal(false);
    expect(closed).to.equal(1);
  });

  it("rejects non-test OAuth settings before authorization or network calls", () => {
    expect(() => new TestUserAuthentication({ ...configuration, cognitoDomain: "https://production.example" }, users))
      .to.throw("test environment");
    expect(() => new TestUserAuthentication({ ...configuration, callbackUrl: "http://localhost:5173/other" }, users))
      .to.throw("test environment");
  });
});
