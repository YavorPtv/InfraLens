import { expect } from "chai";
import { describe, it } from "mocha";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestFrontendPolicy, runTestFrontendWorkflow } from "../src/test-frontend-workflow";
import type { ProcessCall, ProcessRunner } from "../src/deployment-workflow";

const publishFlags = ["--target", "test", "--region", "eu-central-1", "--stack", "InfraLensTestStack",
  "--profile", "infralens-test-frontend"];

function testOutputs() {
  const origin = "https://example.cloudfront.net";
  return { InfraLensTestStack: {
    DeploymentEnvironment: "test", DeploymentAccount: "230944684535", DeploymentRegion: "eu-central-1",
    DeploymentStackName: "InfraLensTestStack", AnalysisApiBaseUrl: "https://example.execute-api.eu-central-1.amazonaws.com/test/",
    FrontendOrigin: origin, AllowedFrontendOrigins: `${origin},http://localhost:5173`,
    FrontendBucketName: "infralensteststack-frontendbucketabc-example",
    FrontendDistributionId: "EEXAMPLE", FrontendDistributionDomainName: "example.cloudfront.net",
    CognitoCallbackUrls: `${origin}/auth/callback,http://localhost:5173/auth/callback`,
    CognitoLogoutUrls: `${origin}/,http://localhost:5173/`, CognitoUserPoolId: "eu-central-1_example",
    CognitoWebClientId: "exampleclient", CognitoHostedDomain: "https://infralens-test-230944684535-euc1.auth.eu-central-1.amazoncognito.com"
  } };
}

function liveStack() {
  return { Stacks: [{ StackId: "arn:aws:cloudformation:eu-central-1:230944684535:stack/InfraLensTestStack/example",
    StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(testOutputs().InfraLensTestStack)
      .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] };
}

function liveDistribution() {
  return { Distribution: { ARN: "arn:aws:cloudfront::230944684535:distribution/EEXAMPLE", Id: "EEXAMPLE",
    Status: "Deployed", DomainName: "example.cloudfront.net",
    DistributionConfig: { Enabled: true, DefaultRootObject: "index.html", Origins: { Items: [{
      DomainName: "infralensteststack-frontendbucketabc-example.s3.eu-central-1.amazonaws.com",
      OriginAccessControlId: "EACCESS", OriginPath: ""
    }] } } } };
}

function withWorkspace(action: (cdkDirectory: string, webDirectory: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), "infralens-frontend-"));
  try {
    const cdkDirectory = join(workspace, "infra", "cdk");
    const webDirectory = join(workspace, "apps", "web");
    mkdirSync(cdkDirectory, { recursive: true });
    mkdirSync(webDirectory, { recursive: true });
    writeFileSync(join(cdkDirectory, "cdk-outputs.test.json"), JSON.stringify(testOutputs()), "utf8");
    action(cdkDirectory, webDirectory);
  } finally {
    // Only this newly created fixture workspace, never a caller-selected checkout.
    rmSync(workspace, { recursive: true, force: true });
  }
}

function writeBuild(webDirectory: string): void {
  const directory = join(webDirectory, "dist", "aws-test");
  mkdirSync(join(directory, "assets"), { recursive: true });
  writeFileSync(join(directory, "index.html"), '<script src="/assets/index-abcdefgh.js"></script>');
  writeFileSync(join(directory, "assets", "index-abcdefgh.js"), "/* test build */");
  writeFileSync(join(directory, "assets", "index-abcdefgh.css"), "body {}");
}

function mockRunner(webDirectory: string, calls: ProcessCall[]): ProcessRunner {
  return call => {
    calls.push(call);
    if (call.executable === process.execPath) { writeBuild(webDirectory); return ""; }
    if (call.args[0] === "sts") return JSON.stringify({ Account: "230944684535" });
    if (call.args[0] === "cloudformation") return JSON.stringify(liveStack());
    if (call.args[0] === "s3api" && call.args[1] === "get-bucket-location") return '{"LocationConstraint":"eu-central-1"}';
    if (call.args[0] === "cloudfront" && call.args[1] === "get-distribution") return JSON.stringify(liveDistribution());
    if (call.args[0] === "cloudfront" && call.args[1] === "create-invalidation") return '{"Invalidation":{"Id":"IEXAMPLE"}}';
    return "{}";
  };
}

function writes(calls: ProcessCall[]): ProcessCall[] {
  return calls.filter(call => call.args[1] === "put-object" || call.args[1] === "create-invalidation");
}

describe("guarded test frontend publishing", () => {
  it("requires an explicit test target and named publish profile, region and stack", () => {
    for (const args of [
      ["build"], ["permissions", "--target", "production"], ["publish", "--target", "test"],
      ["build", "--target", "test", "--profile", "admin"], ["build", "--target", "development"],
      ["build", "--target", "test", "--target", "test"], ["unknown", "--target", "test"],
      ["publish", ...publishFlags.filter((value, index) => value !== "--profile" && publishFlags[index - 1] !== "--profile")],
      ["publish", ...publishFlags.map(value => value === "eu-central-1" ? "us-east-1" : value)],
      ["publish", ...publishFlags.map(value => value === "InfraLensTestStack" ? "CDKToolkit" : value)]
    ]) {
      let calls = 0;
      expect(() => runTestFrontendWorkflow(args, () => { calls++; return ""; }, "/missing")).to.throw();
      expect(calls).to.equal(0);
    }
  });

  it("rejects mismatched outputs and substituted frontend resources before processes run", () => {
    withWorkspace(directory => {
      for (const changes of [
        { DeploymentAccount: "609124256824" }, { FrontendBucketName: "artifact-bucket" },
        { FrontendDistributionId: "EEXAMPLE/*" }, { FrontendDistributionDomainName: "other.cloudfront.net" },
        { CognitoCallbackUrls: "https://other.cloudfront.net/auth/callback" }
      ]) {
        const document = testOutputs();
        Object.assign(document.InfraLensTestStack, changes);
        writeFileSync(join(directory, "cdk-outputs.test.json"), JSON.stringify(document));
        let calls = 0;
        expect(() => runTestFrontendWorkflow(["publish", ...publishFlags], () => { calls++; return ""; }, directory)).to.throw();
        expect(calls).to.equal(0);
      }
      expect(() => createTestFrontendPolicy("test", { ...testOutputs(), InfraLensProdStack: {} })).to.throw();
    });
  });

  it("prepares exact upload/cache-refresh permissions without deployment or data access", () => {
    const policy = createTestFrontendPolicy("test", testOutputs());
    const actions = policy.Statement.flatMap(statement => statement.Action);
    expect(actions).to.have.members(["sts:GetCallerIdentity", "cloudformation:DescribeStacks", "s3:GetBucketLocation",
      "s3:PutObject", "cloudfront:GetDistribution", "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]);
    const upload = policy.Statement.find(item => item.Sid === "UploadFrontendFiles")!;
    expect(upload.Resource).to.equal("arn:aws:s3:::infralensteststack-frontendbucketabc-example/*");
    expect(upload.Condition).to.deep.equal({ StringEquals: { "aws:RequestedRegion": "eu-central-1",
      "s3:ResourceAccount": "230944684535", "s3:x-amz-server-side-encryption": "AES256" } });
    const distribution = policy.Statement.find(item => item.Sid === "CheckAndRefreshTestDistribution")!;
    expect(distribution.Resource).to.equal("arn:aws:cloudfront::230944684535:distribution/EEXAMPLE");
    expect(distribution.Condition).to.equal(undefined);
    expect(JSON.stringify(policy)).not.to.include("609124256824");
    expect(Buffer.byteLength(JSON.stringify(policy))).to.be.lessThan(10240);
    expect(() => createTestFrontendPolicy("production", testOutputs())).to.throw("production");
    withWorkspace(directory => {
      runTestFrontendWorkflow(["permissions", "--target", "test"], () => { throw new Error("No process permitted"); }, directory);
      expect(JSON.parse(readFileSync(join(directory, "cdk.out", "test-frontend.policy.json"), "utf8"))).to.deep.equal(policy);
    });
  });

  it("builds offline with pinned test authentication and no inherited AWS credentials or Vite overrides", () => {
    withWorkspace((directory, web) => {
      const calls: ProcessCall[] = [];
      runTestFrontendWorkflow(["build", "--target", "test"], mockRunner(web, calls), directory, {
        AWS_PROFILE: "production", AWS_ACCESS_KEY_ID: "unused", AWS_ENDPOINT_URL: "http://unused",
        NODE_ENV: "development", VITE_INFRALENS_COGNITO_CLIENT_ID: "other-client", VITE_CUSTOM: "unused",
        INFRALENS_TEST_USER_A_PASSWORD: "unused", INFRALENS_HOSTED_TEST_CONFIG: "unused"
      });
      expect(calls).to.have.length(1);
      expect(calls[0].cwd).to.equal(web);
      expect(calls[0].args).to.include("aws-test-hosted");
      expect(calls[0].env.AWS_PROFILE).to.equal(undefined);
      expect(calls[0].env.AWS_ACCESS_KEY_ID).to.equal(undefined);
      expect(calls[0].env.INFRALENS_TEST_USER_A_PASSWORD).to.equal(undefined);
      expect(calls[0].env.VITE_CUSTOM).to.equal(undefined);
      expect(calls[0].env.NODE_ENV).to.equal("production");
      expect(calls[0].env.VITE_INFRALENS_AUTH_ENABLED).to.equal("true");
      expect(calls[0].env.VITE_INFRALENS_COGNITO_CLIENT_ID).to.equal("exampleclient");
      expect(calls[0].env.VITE_INFRALENS_COGNITO_REDIRECT_URI).to.equal("https://example.cloudfront.net/auth/callback");
      expect(readFileSync(join(web, ".env.aws-test-local.local"), "utf8")).to.include("http://localhost:5173/auth/callback");
    });
  });

  it("blocks a wrong caller account and failed AWS identity requests before building or uploading", () => {
    withWorkspace(directory => {
      for (const failure of [false, true]) {
        const calls: ProcessCall[] = [];
        expect(() => runTestFrontendWorkflow(["publish", ...publishFlags], call => {
          calls.push(call);
          if (failure) throw new Error("Expired SSO session");
          return '{"Account":"609124256824"}';
        }, directory)).to.throw();
        expect(calls).to.have.length(1);
        expect(writes(calls)).to.have.length(0);
      }
    });
  });

  it("blocks stale outputs, failed stacks, foreign bucket locations and substituted distributions", () => {
    withWorkspace((directory, web) => {
      for (const scenario of ["stale", "failed-stack", "stack-account", "bucket-region", "distribution-account", "origin", "disabled", "no-access-control"]) {
        const calls: ProcessCall[] = [];
        const runner = mockRunner(web, calls);
        expect(() => runTestFrontendWorkflow(["publish", ...publishFlags], call => {
          if (call.args[0] === "cloudformation") {
            calls.push(call);
            const stack = liveStack();
            if (scenario === "stale") stack.Stacks[0].Outputs[0].OutputValue = "wrong";
            if (scenario === "failed-stack") stack.Stacks[0].StackStatus = "ROLLBACK_COMPLETE";
            if (scenario === "stack-account") stack.Stacks[0].StackId = stack.Stacks[0].StackId.replace("230944684535", "609124256824");
            return JSON.stringify(stack);
          }
          if (call.args[1] === "get-bucket-location" && scenario === "bucket-region") {
            calls.push(call); return '{"LocationConstraint":"us-east-1"}';
          }
          if (call.args[1] === "get-distribution") {
            calls.push(call);
            const distribution = liveDistribution();
            if (scenario === "distribution-account") distribution.Distribution.ARN = distribution.Distribution.ARN.replace("230944684535", "609124256824");
            if (scenario === "origin") distribution.Distribution.DistributionConfig.Origins.Items[0].DomainName = "other.s3.amazonaws.com";
            if (scenario === "disabled") distribution.Distribution.DistributionConfig.Enabled = false;
            if (scenario === "no-access-control") distribution.Distribution.DistributionConfig.Origins.Items[0].OriginAccessControlId = "";
            return JSON.stringify(distribution);
          }
          return runner(call);
        }, directory)).to.throw();
        expect(calls.some(call => call.executable === process.execPath)).to.equal(false);
        expect(writes(calls)).to.have.length(0);
      }
    });
  });

  it("publishes assets before index, pins encryption/ownership and waits for only the selected distribution", () => {
    withWorkspace((directory, web) => {
      const calls: ProcessCall[] = [];
      runTestFrontendWorkflow(["publish", ...publishFlags], mockRunner(web, calls), directory, {
        AWS_ACCESS_KEY_ID: "unused", AWS_PROFILE: "production", AWS_ENDPOINT_URL: "http://unused", INFRALENS_TEST_USER_A_PASSWORD: "unused"
      });
      expect(calls.slice(0, 4).map(call => call.args[1])).to.deep.equal([
        "get-caller-identity", "describe-stacks", "get-bucket-location", "get-distribution"
      ]);
      const uploads = calls.filter(call => call.args[1] === "put-object");
      expect(uploads.map(call => call.args[call.args.indexOf("--key") + 1])).to.deep.equal([
        "assets/index-abcdefgh.css", "assets/index-abcdefgh.js", "index.html"
      ]);
      expect(uploads[0].args).to.include("public,max-age=31536000,immutable");
      expect(uploads[2].args).to.include("no-cache,max-age=0,must-revalidate");
      expect(uploads[2].args).to.include("text/html");
      for (const call of calls.filter(item => item.executable === "aws")) {
        expect(call.args).to.include("infralens-test-frontend");
        expect(call.env.AWS_PROFILE).to.equal("infralens-test-frontend");
        expect(call.env.AWS_ACCESS_KEY_ID).to.equal(undefined);
        expect(call.env.AWS_ENDPOINT_URL).to.equal(undefined);
        expect(call.env.INFRALENS_TEST_USER_A_PASSWORD).to.equal(undefined);
      }
      for (const upload of uploads) {
        expect(upload.args).to.include("AES256");
        expect(upload.args).to.include("230944684535");
        expect(upload.args).not.to.include("--acl");
      }
      expect(calls[calls.length - 2].args).to.include("/*");
      expect(calls[calls.length - 1].args.slice(0, 3)).to.deep.equal(["cloudfront", "wait", "invalidation-completed"]);
      expect(calls[calls.length - 1].args).to.include("EEXAMPLE");
      expect(calls[calls.length - 1].args).to.include("IEXAMPLE");
    });
  });

  it("does not upload an empty build or follow a build-directory junction", () => {
    withWorkspace((directory, web) => {
      const calls: ProcessCall[] = [];
      const runner = mockRunner(web, calls);
      expect(() => runTestFrontendWorkflow(["publish", ...publishFlags], call => {
        if (call.executable === process.execPath) {
          calls.push(call);
          mkdirSync(join(web, "dist", "aws-test"), { recursive: true });
          writeFileSync(join(web, "dist", "aws-test", "index.html"), "");
          return "";
        }
        return runner(call);
      }, directory)).to.throw("fresh hosted frontend");
      expect(writes(calls)).to.have.length(0);
      rmSync(join(web, "dist"), { recursive: true });
      const outside = join(directory, "outside-build");
      mkdirSync(outside);
      writeFileSync(join(outside, "preserve.txt"), "preserve");
      symlinkSync(outside, join(web, "dist"), "junction");
      expect(() => runTestFrontendWorkflow(["build", "--target", "test"], () => { throw new Error("must not build"); }, directory))
        .to.throw("real directory");
      expect(readFileSync(join(outside, "preserve.txt"), "utf8")).to.equal("preserve");
    });
  });

  it("stops on asset upload failure before replacing index or invalidating the cache", () => {
    withWorkspace((directory, web) => {
      const calls: ProcessCall[] = [];
      const runner = mockRunner(web, calls);
      expect(() => runTestFrontendWorkflow(["publish", ...publishFlags], call => {
        if (call.args[1] === "put-object") { calls.push(call); throw new Error("upload failed"); }
        return runner(call);
      }, directory)).to.throw("upload failed");
      expect(writes(calls)).to.have.length(1);
      expect(writes(calls)[0].args).not.to.include("index.html");
      expect(calls.some(call => call.args[1] === "create-invalidation")).to.equal(false);
    });
  });

  it("does not upload when the fresh build fails, even if a prior build exists", () => {
    withWorkspace((directory, web) => {
      writeBuild(web);
      const calls: ProcessCall[] = [];
      const runner = mockRunner(web, calls);
      expect(() => runTestFrontendWorkflow(["publish", ...publishFlags], call => {
        if (call.executable === process.execPath) { calls.push(call); throw new Error("build failed"); }
        return runner(call);
      }, directory)).to.throw("build failed");
      expect(writes(calls)).to.have.length(0);
    });
  });

  it("rejects linked upload files and revalidates nonhashed assets", () => {
    withWorkspace((directory, web) => {
      for (const linked of [false, true]) {
        const calls: ProcessCall[] = [];
        const runner = mockRunner(web, calls);
        const run = () => runTestFrontendWorkflow(["publish", ...publishFlags], call => {
          if (call.executable === process.execPath) {
            const result = runner(call);
            const logo = join(web, "dist", "aws-test", "assets", "logo.svg");
            if (linked) {
              rmSync(logo, { force: true });
              const outside = join(directory, "outside-assets");
              mkdirSync(outside);
              symlinkSync(outside, join(web, "dist", "aws-test", "linked-assets"), "junction");
            } else {
              writeFileSync(logo, "<svg />");
            }
            return result;
          }
          return runner(call);
        }, directory);
        if (linked) {
          expect(run).to.throw("symbolic links");
          expect(writes(calls)).to.have.length(0);
        } else {
          run();
          const logo = calls.find(call => call.args.includes("assets/logo.svg"))!;
          expect(logo.args).to.include("no-cache,max-age=0,must-revalidate");
          expect(logo.args).to.include("image/svg+xml");
        }
      }
    });
  });

  it("reports invalidation failures without waiting on an unvalidated ID or claiming completion", () => {
    withWorkspace((directory, web) => {
      for (const response of ["permission-error", '{}', '{"Invalidation":{"Id":"wrong/id"}}']) {
        const calls: ProcessCall[] = [];
        const runner = mockRunner(web, calls);
        expect(() => runTestFrontendWorkflow(["publish", ...publishFlags], call => {
          if (call.args[1] === "create-invalidation") {
            calls.push(call);
            if (response === "permission-error") throw new Error("cache refresh failed");
            return response;
          }
          return runner(call);
        }, directory)).to.throw();
        expect(calls.filter(call => call.args[1] === "put-object")).to.have.length(3);
        expect(calls.some(call => call.args[1] === "wait")).to.equal(false);
      }
    });
  });
});
