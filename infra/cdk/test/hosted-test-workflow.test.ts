import { expect } from "chai";
import { describe, it } from "mocha";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostedTestConfiguration, parseHostedTestRequest, runHostedTestWorkflow } from "../src/hosted-test-workflow";
import type { ProcessCall } from "../src/deployment-workflow";

const writeOptions = ["--target", "test", "--region", "eu-central-1", "--stack", "InfraLensTestStack",
  "--profile", "infralens-test-deploy", "--allow-test-data", "true"];
const setupOptions = ["--target", "test", "--region", "eu-central-1", "--stack", "InfraLensTestStack",
  "--profile", "infralens-test-admin", "--allow-user-setup", "true"];

function outputDocument() {
  const origin = "https://example.cloudfront.net";
  return { InfraLensTestStack: {
    DeploymentEnvironment: "test", DeploymentAccount: "230944684535", DeploymentRegion: "eu-central-1",
    DeploymentStackName: "InfraLensTestStack", AnalysisApiBaseUrl: "https://example.execute-api.eu-central-1.amazonaws.com/test/",
    FrontendOrigin: origin, AllowedFrontendOrigins: `${origin},http://localhost:5173`,
    CognitoCallbackUrls: `${origin}/auth/callback,http://localhost:5173/auth/callback`,
    CognitoLogoutUrls: `${origin}/,http://localhost:5173/`, CognitoUserPoolId: "eu-central-1_example",
    CognitoWebClientId: "exampleclient", CognitoHostedDomain: "https://infralens-test-230944684535-euc1.auth.eu-central-1.amazoncognito.com",
    ProjectsTableName: "InfraLensTestStack-ProjectsTableABC-example", RunsTableName: "InfraLensTestStack-RunsTableABC-example",
    ArtifactBucketName: "infralensteststack-artifactbucketabc-example"
  } };
}

function liveStack(document = outputDocument(), status = "CREATE_COMPLETE") {
  return JSON.stringify({ Stacks: [{
    StackId: "arn:aws:cloudformation:eu-central-1:230944684535:stack/InfraLensTestStack/example",
    StackStatus: status,
    Outputs: Object.entries(document.InfraLensTestStack).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }))
  }] });
}

function withOutputFile(action: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "infralens-hosted-tests-"));
  try {
    writeFileSync(join(directory, "cdk-outputs.test.json"), JSON.stringify(outputDocument()));
    action(directory);
  } finally {
    // Exact newly created temporary directory; never a supplied project/output path.
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("persistent test environment workflows", () => {
  it("requires an explicit test target and prohibits production, wrong region and wrong stack", () => {
    for (const args of [
      ["smoke"], ["smoke", "--target", "local"], ["smoke", "--target", "production"],
      ["smoke", "--target", "test", "--region", "us-east-1"],
      ["smoke", "--target", "test", "--stack", "InfraLensProdStack"]
    ]) {
      expect(() => parseHostedTestRequest(args, "/cdk")).to.throw();
    }
  });

  it("requires a named profile and explicit data opt-in before data-writing commands", () => {
    for (const command of ["hosted", "storage"]) {
      for (const omitted of ["--profile", "--allow-test-data"]) {
        const args = writeOptions.filter((value, index) => value !== omitted && writeOptions[index - 1] !== omitted);
        expect(() => parseHostedTestRequest([command, ...args], "/cdk")).to.throw("require");
      }
    }
    expect(() => parseHostedTestRequest(["smoke", "--target", "test", "--allow-test-data", "true"], "/cdk")).to.throw();
  });

  it("rejects foreign outputs, arbitrary resources and production URLs before starting a process", () => {
    const request = parseHostedTestRequest(["smoke", "--target", "test"], "/cdk");
    for (const changes of [
      { DeploymentAccount: "609124256824" }, { DeploymentStackName: "InfraLensProdStack" },
      { AnalysisApiBaseUrl: "https://example.execute-api.eu-central-1.amazonaws.com/production/" },
      { ProjectsTableName: "OtherTable" }, { ArtifactBucketName: "other-bucket" }
    ]) {
      const document = outputDocument();
      Object.assign(document.InfraLensTestStack, changes);
      expect(() => loadHostedTestConfiguration(request, document)).to.throw();
    }
  });

  it("runs only the smoke HTTP suite without AWS identity calls or credentials", () => {
    withOutputFile(directory => {
      const calls: ProcessCall[] = [];
      runHostedTestWorkflow(["smoke", "--target", "test"], call => {
        calls.push(call); return "";
      }, directory, { AWS_ACCESS_KEY_ID: "unused", AWS_PROFILE: "production" });
      expect(calls).to.have.length(1);
      expect(calls[0].args).to.include("test/deployedRoutes.smoke.ts");
      expect(calls[0].env.AWS_ACCESS_KEY_ID).to.equal(undefined);
      expect(calls[0].env.AWS_PROFILE).to.equal(undefined);
      expect(JSON.parse(calls[0].env.INFRALENS_HOSTED_TEST_CONFIG!).allowTestDataWrites).to.equal(false);
    });
  });

  for (const command of ["hosted", "storage", "setup-users"]) {
    it(`blocks ${command} with mismatched STS identity before starting tests`, () => {
      withOutputFile(directory => {
        const calls: ProcessCall[] = [];
        const options = command === "setup-users" ? setupOptions : writeOptions;
        expect(() => runHostedTestWorkflow([command, ...options], call => {
          calls.push(call); return JSON.stringify({ Account: "609124256824" });
        }, directory, {})).to.throw("caller account mismatch");
        expect(calls).to.have.length(1);
      });
    });
  }

  it("requires separate test-user setup permission and never accepts a data-only opt-in", () => {
    for (const args of [
      ["setup-users", ...writeOptions], ["setup-users", "--target", "test"],
      ["setup-users", ...setupOptions, "--allow-test-data", "true"],
      ["setup-users", "--target", "production"], ["smoke", "--target", "test", "--allow-user-setup", "true"]
    ]) {
      expect(() => parseHostedTestRequest(args, "/cdk")).to.throw();
    }
  });

  it("routes user setup through STS and current-stack checks without granting test-data writes", () => {
    withOutputFile(directory => {
      const calls: ProcessCall[] = [];
      runHostedTestWorkflow(["setup-users", ...setupOptions], call => {
        calls.push(call);
        if (call.args[0] === "sts") return '{"Account":"230944684535"}';
        if (call.args[0] === "cloudformation") return liveStack();
        return "";
      }, directory, { INFRALENS_TEST_USER_A_PASSWORD: "fixture-secret" });
      expect(calls).to.have.length(3);
      expect(calls[2].args).to.include("test/testUserSetup.ts");
      const config = JSON.parse(calls[2].env.INFRALENS_HOSTED_TEST_CONFIG!);
      expect(config.allowUserSetup).to.equal(true);
      expect(config.allowTestDataWrites).to.equal(false);
      expect(calls[0].env.INFRALENS_TEST_USER_A_PASSWORD).to.equal(undefined);
      expect(calls[1].env.INFRALENS_TEST_USER_A_PASSWORD).to.equal(undefined);
      expect(calls[2].env.INFRALENS_TEST_USER_A_PASSWORD).to.equal("fixture-secret");
      expect(calls.every(call => !call.args.includes("fixture-secret"))).to.equal(true);
    });
  });

  it("makes authenticated smoke explicit and uses output-pinned OAuth URLs without AWS credentials", () => {
    withOutputFile(directory => {
      const calls: ProcessCall[] = [];
      runHostedTestWorkflow(["smoke", "--target", "test", "--authenticated", "true"], call => {
        calls.push(call); return "";
      }, directory, { INFRALENS_TEST_USER_A_PASSWORD: "fixture-secret", AWS_PROFILE: "production" });
      expect(calls).to.have.length(1);
      const config = JSON.parse(calls[0].env.INFRALENS_HOSTED_TEST_CONFIG!);
      expect(config.authenticatedSmoke).to.equal(true);
      expect(config.callbackUrl).to.equal("http://localhost:5173/auth/callback");
      expect(config.cognitoDomain).to.equal(outputDocument().InfraLensTestStack.CognitoHostedDomain);
      expect(calls[0].env.AWS_PROFILE).to.equal(undefined);
      expect(calls[0].env.INFRALENS_TEST_USER_A_PASSWORD).to.equal("fixture-secret");
    });
  });

  it("strips credentials from public smoke and rejects static access-token overrides", () => {
    withOutputFile(directory => {
      runHostedTestWorkflow(["smoke", "--target", "test"], call => {
        expect(call.env.INFRALENS_TEST_USER_A_PASSWORD).to.equal(undefined); return "";
      }, directory, { INFRALENS_TEST_USER_A_PASSWORD: "fixture-secret" });
      for (const name of ["INFRALENS_TEST_USER_A_TOKEN", "INFRALENS_TEST_USER_B_TOKEN", "INFRALENS_SMOKE_ACCESS_TOKEN"]) {
        let calls = 0;
        expect(() => runHostedTestWorkflow(["smoke", "--target", "test"], () => { calls++; return ""; },
          directory, { [name]: "fixture-token" })).to.throw("legacy");
        expect(calls).to.equal(0);
      }
    });
  });

  it("blocks stale output files and failed or missing application stacks before tests", () => {
    const stale = outputDocument();
    stale.InfraLensTestStack.RunsTableName += "-old";
    for (const response of [liveStack(stale), liveStack(outputDocument(), "ROLLBACK_COMPLETE"), "{\"Stacks\":[]}"]) {
      withOutputFile(directory => {
        const calls: ProcessCall[] = [];
        expect(() => runHostedTestWorkflow(["storage", ...writeOptions], call => {
          calls.push(call);
          if (call.args[0] === "sts") return '{"Account":"230944684535"}';
          return response;
        }, directory, {})).to.throw();
        expect(calls).to.have.length(2);
      });
    }
  });

  it("pins verified identity/profile/region and selects separate hosted and storage suites", () => {
    for (const [command, filename] of [["hosted", "test/hostedHistory.hosted.ts"], ["storage", "test/history.aws.ts"]]) {
      withOutputFile(directory => {
        const calls: ProcessCall[] = [];
        runHostedTestWorkflow([command, ...writeOptions], call => {
          calls.push(call);
          if (call.args[0] === "sts") return '{"Account":"230944684535"}';
          if (call.args[0] === "cloudformation") return liveStack();
          return "";
        }, directory, { AWS_ACCESS_KEY_ID: "unused", AWS_ENDPOINT_URL: "http://unused", AWS_PROFILE: "production" });
        expect(calls).to.have.length(3);
        const test = calls[2];
        expect(test.args).to.include(filename);
        expect(test.env.AWS_PROFILE).to.equal("infralens-test-deploy");
        expect(test.env.AWS_REGION).to.equal("eu-central-1");
        expect(test.env.AWS_ENDPOINT_URL).to.equal(undefined);
        expect(test.env.AWS_ACCESS_KEY_ID).to.equal(undefined);
        expect(JSON.parse(test.env.INFRALENS_HOSTED_TEST_CONFIG!).allowTestDataWrites).to.equal(true);
      });
    }
  });

  it("fails closed on STS errors and rejects legacy variables rather than shadowing them", () => {
    withOutputFile(directory => {
      expect(() => runHostedTestWorkflow(["storage", ...writeOptions], () => {
        throw new Error("SSO session expired");
      }, directory, {})).to.throw("SSO session expired");
      let calls = 0;
      expect(() => runHostedTestWorkflow(["smoke", "--target", "test"], () => {
        calls++; return "";
      }, directory, { INFRALENS_SMOKE_API_BASE_URL: "https://old.example" })).to.throw("legacy");
      expect(calls).to.equal(0);
    });
  });
});
