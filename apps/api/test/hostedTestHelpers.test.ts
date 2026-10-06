import { expect } from "chai";
import { describe, it } from "mocha";
import { distinctTestUsers, hostedTestRequest, readHostedTestConfiguration, requireTestDataWrites,
  testAccessTokenSubject, type HostedTestConfiguration } from "./hostedTestHelpers";

const configuration: HostedTestConfiguration = {
  target: "test", account: "230944684535", region: "eu-central-1", stackName: "InfraLensTestStack",
  profile: "infralens-test-deploy", apiBaseUrl: "https://example.execute-api.eu-central-1.amazonaws.com/test/",
  projectsTable: "InfraLensTestStack-ProjectsTableABC-example", runsTable: "InfraLensTestStack-RunsTableABC-example",
  artifactBucket: "infralensteststack-artifactbucketabc-example", userPoolId: "eu-central-1_example",
  clientId: "exampleclient", allowTestDataWrites: false
};
const now = 1_800_000_000_000;
function token(overrides: Record<string, unknown> = {}) {
  const claims = {
    iss: `https://cognito-idp.${configuration.region}.amazonaws.com/${configuration.userPoolId}`,
    client_id: configuration.clientId, token_use: "access", sub: "test-owner-a", scope: "openid",
    exp: now / 1000 + 300, ...overrides
  };
  // Deliberately unsigned fixture: these tests check configuration, never authentication signatures.
  return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
}

describe("hosted test helpers (offline)", () => {
  it("requires generated test configuration and rejects production or arbitrary resource values", () => {
    expect(() => readHostedTestConfiguration({})).to.throw("guarded");
    for (const override of [
      { target: "production" }, { account: "609124256824" }, { region: "us-east-1" },
      { projectsTable: "production-table" }, { artifactBucket: "production-bucket" },
      { apiBaseUrl: "https://example.execute-api.eu-central-1.amazonaws.com/production/" }
    ]) {
      expect(() => readHostedTestConfiguration({
        INFRALENS_HOSTED_TEST_CONFIG: JSON.stringify({ ...configuration, ...override })
      })).to.throw("test environment");
    }
    expect(readHostedTestConfiguration({ INFRALENS_HOSTED_TEST_CONFIG: JSON.stringify(configuration) }))
      .to.deep.equal(configuration);
  });

  it("requires explicit permission to write temporary data", () => {
    expect(() => requireTestDataWrites(configuration)).to.throw("allow-test-data");
    expect(() => requireTestDataWrites({ ...configuration, allowTestDataWrites: true })).not.to.throw();
  });

  it("rejects expired, ID, wrong-pool, wrong-client and missing-scope tokens without revealing them", () => {
    for (const value of [undefined, "invalid-secret-token", token({ exp: now / 1000 }),
      token({ token_use: "id" }), token({ iss: "https://production.example" }),
      token({ client_id: "anotherclient" }), token({ scope: "email" }), token({ sub: "" })]) {
      try {
        testAccessTokenSubject(value, configuration, "Test token", now);
        expect.fail("Invalid token configuration accepted");
      } catch (error) {
        expect((error as Error).message).to.include("current test Cognito access token");
        if (value) expect((error as Error).message).not.to.include(value);
      }
    }
    expect(testAccessTokenSubject(token(), configuration, "Test token", now)).to.equal("test-owner-a");
  });

  it("checks different Cognito subjects even when two token strings differ", () => {
    expect(() => distinctTestUsers(token(), token({ exp: now / 1000 + 400 }), configuration, now))
      .to.throw("different Cognito user subjects");
    expect(() => distinctTestUsers(token(), token({ sub: "test-owner-b" }), configuration, now)).not.to.throw();
  });

  it("preserves the API stage and always applies a timeout and rejects redirects", async () => {
    let receivedUrl = "";
    let receivedOptions: RequestInit = {};
    const fetcher: typeof fetch = async (url, options) => {
      receivedUrl = String(url);
      receivedOptions = options ?? {};
      return new Response("{}", { status: 200 });
    };
    await hostedTestRequest(configuration, "projects/example", { redirect: "follow" }, fetcher);
    expect(receivedUrl).to.equal(`${configuration.apiBaseUrl}projects/example`);
    expect(receivedOptions.redirect).to.equal("error");
    expect(receivedOptions.signal).to.be.instanceOf(AbortSignal);
    for (const path of ["/projects", "https://other.example", "../production"]) {
      expect(() => hostedTestRequest(configuration, path, {}, fetcher)).to.throw("relative");
    }
  });
});
