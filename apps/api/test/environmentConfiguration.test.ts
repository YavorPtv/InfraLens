import { expect } from "chai";
import { describe, it } from "mocha";
import { resolveAuthConfig, authSessionStorageKey, validateFrontendMode } from "../../web/src/auth/authConfig";
import { getAllowedOrigins, getCorsResponseHeaders } from "../src/corsConfig";
import { configuredHistory, localHistoryOwner } from "../src/historyConfig";
import { createApiApp } from "../src/index";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

function frontendEnvironment(target: "test" | "production", origin: string) {
  const prefix = target === "test" ? "infralens-test-230944684535-euc1" : "infralens-prod-609124256824-euc1";
  return {
    VITE_INFRALENS_DEPLOYMENT_TARGET: target,
    VITE_INFRALENS_API_BASE_URL: `https://example.execute-api.eu-central-1.amazonaws.com/${target}/`,
    VITE_INFRALENS_AUTH_ENABLED: "true",
    VITE_INFRALENS_COGNITO_CLIENT_ID: `${target}client`,
    VITE_INFRALENS_COGNITO_DOMAIN: `https://${prefix}.auth.eu-central-1.amazoncognito.com`,
    VITE_INFRALENS_FRONTEND_ORIGIN: origin,
    VITE_INFRALENS_COGNITO_REDIRECT_URI: `${origin}/auth/callback`,
    VITE_INFRALENS_COGNITO_LOGOUT_URI: `${origin}/`
  };
}

describe("local and hosted environment configuration", () => {
  it("permits local frontend mode without AWS settings", () => {
    expect(resolveAuthConfig({})).to.equal(undefined);
    expect(resolveAuthConfig({ VITE_INFRALENS_API_BASE_URL: "http://localhost:3000", VITE_INFRALENS_AUTH_ENABLED: "false" })).to.equal(undefined);
  });

  it("fails hosted build modes when generated configuration is absent or belongs to another target", () => {
    expect(() => validateFrontendMode("production", {})).not.to.throw();
    for (const mode of ["aws-test-local", "aws-test-hosted", "aws-production-hosted", "aws-production-local"]) {
      expect(() => validateFrontendMode(mode, {})).to.throw("matching generated deployment configuration");
    }
    expect(() => validateFrontendMode("aws-test-hosted", frontendEnvironment("production", "https://prod.cloudfront.net"))).to.throw("matching");
  });

  it("requires the matching local or hosted frontend variant in AWS build modes", () => {
    const local = frontendEnvironment("test", "http://localhost:5173");
    const hosted = frontendEnvironment("test", "https://test.cloudfront.net");
    expect(() => validateFrontendMode("aws-test-local", local)).not.to.throw();
    expect(() => validateFrontendMode("aws-test-hosted", hosted)).not.to.throw();
    expect(() => validateFrontendMode("aws-test-hosted", local)).to.throw("does not match mode");
    expect(() => validateFrontendMode("aws-test-local", hosted)).to.throw("does not match mode");
  });

  it("requires test Cognito for both local and deployed test frontends", () => {
    for (const origin of ["http://localhost:5173", "https://test.cloudfront.net"]) {
      const environment = frontendEnvironment("test", origin);
      expect(resolveAuthConfig(environment, origin)?.redirectUri).to.equal(`${origin}/auth/callback`);
      expect(() => resolveAuthConfig({ ...environment, VITE_INFRALENS_AUTH_ENABLED: "false" }, origin)).to.throw("must be enabled");
      expect(() => resolveAuthConfig({ ...environment, VITE_INFRALENS_DEPLOYMENT_TARGET: "" }, origin)).to.throw("requires");
    }
  });

  it("rejects mismatched origins, callbacks, regions, API stages and Cognito environments", () => {
    const environment = frontendEnvironment("test", "http://localhost:5173");
    for (const override of [
      { VITE_INFRALENS_COGNITO_REDIRECT_URI: "https://wrong.example.com/auth/callback" },
      { VITE_INFRALENS_COGNITO_LOGOUT_URI: "https://wrong.example.com/" },
      { VITE_INFRALENS_COGNITO_DOMAIN: frontendEnvironment("production", "https://prod.cloudfront.net").VITE_INFRALENS_COGNITO_DOMAIN },
      { VITE_INFRALENS_API_BASE_URL: "https://example.execute-api.eu-central-1.amazonaws.com/production/" },
      { VITE_INFRALENS_API_BASE_URL: "https://example.execute-api.us-east-1.amazonaws.com/test/" }
    ]) {
      expect(() => resolveAuthConfig({ ...environment, ...override })).to.throw();
    }
    expect(() => resolveAuthConfig(environment, "http://localhost:5174")).to.throw("origin");
    expect(() => resolveAuthConfig(frontendEnvironment("production", "http://localhost:5173"))).to.throw("origin");
    expect(resolveAuthConfig(frontendEnvironment("production", "https://prod.cloudfront.net"))).not.to.equal(undefined);
  });

  it("separates test and production browser session keys", () => {
    const testConfig = resolveAuthConfig(frontendEnvironment("test", "http://localhost:5173"))!;
    const prodConfig = resolveAuthConfig(frontendEnvironment("production", "https://prod.cloudfront.net"))!;
    expect(authSessionStorageKey(testConfig, "tokens")).not.to.equal(authSessionStorageKey(prodConfig, "tokens"));
  });

  it("uses exact origins and never falls back to local CORS in hosted mode", () => {
    const origins = getAllowedOrigins({ INFRALENS_ENVIRONMENT: "production", INFRALENS_CORS_ORIGINS: "https://test.cloudfront.net,http://localhost:5173" });
    for (const origin of origins) {
      expect(getCorsResponseHeaders(origin, origins)).to.deep.equal({ "access-control-allow-origin": origin, vary: "Origin" });
    }
    expect(getCorsResponseHeaders("https://production.cloudfront.net", origins)).to.deep.equal({});
    expect(() => getAllowedOrigins({ INFRALENS_ENVIRONMENT: "production" })).to.throw("explicit");
    expect(() => getAllowedOrigins({ INFRALENS_CORS_ORIGINS: "*" })).to.throw();
  });

  it("serves local memory history with explicit fake identity and no AWS configuration", async () => {
    const environment = {
      NODE_ENV: "development", INFRALENS_ENVIRONMENT: "development",
      INFRALENS_HISTORY_ADAPTER: "memory", INFRALENS_LOCAL_OWNER: "local-developer"
    };
    const history = configuredHistory(false, environment);
    const app = createApiApp({ history, localOwner: localHistoryOwner(environment) });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${baseUrl}/projects`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Offline project" })
      });
      expect(response.status).to.equal(201);
      const list = await fetch(`${baseUrl}/projects`);
      expect((await list.json() as { items: unknown[] }).items).to.have.length(1);
      expect(() => configuredHistory(true, environment)).to.throw("local-only");
      expect(() => localHistoryOwner({ ...environment, INFRALENS_ENVIRONMENT: "production" })).to.throw("Local identity");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
