import { expect } from "chai";
import { describe, it } from "mocha";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDeploymentTarget, validateDeploymentTarget } from "../src/deployment-target";
import {
  createFrontendConfigurations, deploymentPaths, deploymentProcessEnvironment,
  parseDeploymentRequest, runDeploymentWorkflow, verifyAssembly, type ProcessCall
} from "../src/deployment-workflow";

const testTarget = resolveDeploymentTarget("test");
const productionTarget = resolveDeploymentTarget("production");
const testOptions = ["--target", "test", "--region", "eu-central-1", "--stack", "InfraLensTestStack"];

function assembly() {
  return { artifacts: {
    InfraLensTestStack: {
      type: "aws:cloudformation:stack", environment: "aws://230944684535/eu-central-1",
      properties: { stackName: "InfraLensTestStack" }
    }
  } };
}

describe("explicit deployment targets and operational safeguards", () => {
  it("rejects missing, invalid, runtime, and implicit targets", () => {
    for (const value of [undefined, "", "development", "local", "prod", "TEST", {}, false]) {
      expect(() => resolveDeploymentTarget(value)).to.throw("explicit deployment target");
    }
    expect(() => parseDeploymentRequest(["synth"])).to.throw("explicit deployment target");
    expect(() => parseDeploymentRequest(["deploy", "--target", "test", "--all", "true"])).to.throw("Invalid");
    expect(() => parseDeploymentRequest(["synth", "--target", "test", "--target", "production"])).to.throw("duplicate");
  });

  it("pins distinct accounts, stacks, profiles and Cognito domains independent of runtime mode", () => {
    expect(testTarget.account).to.equal("230944684535");
    expect(testTarget.stackName).to.equal("InfraLensTestStack");
    expect(testTarget.profile).to.equal("infralens-test-admin");
    expect(productionTarget.account).to.equal("609124256824");
    expect(productionTarget.stackName).to.equal("InfraLensProdStack");
    expect(productionTarget.profile).to.equal("infralens-prod-admin");
    expect(testTarget.region).to.equal("eu-central-1");
    expect(productionTarget.regionConfirmed).to.equal(false);
    expect(testTarget.runtimeEnvironment).to.equal(productionTarget.runtimeEnvironment);
    expect(testTarget.cognitoDomainPrefix).not.to.equal(productionTarget.cognitoDomainPrefix);
    expect(() => validateDeploymentTarget({ ...testTarget, account: productionTarget.account })).to.throw("must match");
    expect(() => validateDeploymentTarget({ ...testTarget, stackName: "CDKToolkit" })).to.throw("must match");
  });

  it("rejects wildcard, path, and production localhost origins", () => {
    for (const origin of ["*", "https://*.example.com", "https://app.example.com/path", "http://localhost:5173"]) {
      expect(() => validateDeploymentTarget({ ...productionTarget, additionalFrontendOrigins: [origin] })).to.throw();
    }
  });

  it("requires matching intended region and stack before making AWS calls", () => {
    for (const flags of [[], ["--region", "us-east-1"], ["--region", "eu-central-1", "--stack", "InfraLensProdStack"],
      ["--region", "eu-central-1", "--stack", "CDKToolkit"]]) {
      const calls: ProcessCall[] = [];
      expect(() => runDeploymentWorkflow(["deploy", "--target", "test", ...flags], (call) => {
        calls.push(call); return "{}";
      })).to.throw();
      expect(calls).to.have.length(0);
    }
  });

  it("permits offline production synthesis but gates online commands on region confirmation", () => {
    expect(parseDeploymentRequest(["synth", "--target", "production"]).target).to.deep.equal(productionTarget);
    const args = ["preflight", "--target", "production", "--region", "eu-central-1", "--stack", "InfraLensProdStack"];
    expect(() => parseDeploymentRequest(args)).to.throw("not confirmed");
    expect(parseDeploymentRequest([...args, "--confirm-production-region", "eu-central-1"]).target).to.deep.equal(productionTarget);
  });

  for (const command of ["preflight", "diff", "deploy"]) {
    it(`blocks ${command} when STS returns the wrong account, even with the named test profile`, () => {
      const calls: ProcessCall[] = [];
      expect(() => runDeploymentWorkflow([command, ...testOptions], (call) => {
        calls.push(call);
        return JSON.stringify({ Account: productionTarget.account });
      })).to.throw("AWS caller account mismatch");
      expect(calls).to.have.length(1);
      expect(calls[0].args.slice(0, 2)).to.deep.equal(["sts", "get-caller-identity"]);
      expect(calls[0].args).to.include.members(["--profile", "infralens-test-admin", "--region", "eu-central-1"]);
    });
  }

  it("stops on STS errors or malformed identity without starting CDK", () => {
    for (const response of ["{}", "null", "not json"]) {
      let calls = 0;
      expect(() => runDeploymentWorkflow(["deploy", ...testOptions], () => {
        calls++; return response;
      })).to.throw();
      expect(calls).to.equal(1);
    }
    expect(() => runDeploymentWorkflow(["deploy", ...testOptions], () => {
      throw new Error("SSO session expired");
    })).to.throw("SSO session expired");
  });

  it("stops on missing or unhealthy bootstrap, without attempting bootstrap", () => {
    const calls: ProcessCall[] = [];
    expect(() => runDeploymentWorkflow(["deploy", ...testOptions], (call) => {
      calls.push(call);
      return calls.length === 1 ? JSON.stringify({ Account: testTarget.account }) : JSON.stringify({ Stacks: [] });
    })).to.throw("CDKToolkit must exist");
    expect(calls).to.have.length(2);
    expect(calls[1].args.slice(0, 4)).to.deep.equal(["cloudformation", "describe-stacks", "--stack-name", "CDKToolkit"]);
  });

  it("clears ambient credentials, endpoints, context and region before pinning the chosen profile", () => {
    const request = parseDeploymentRequest(["deploy", ...testOptions]);
    const environment = deploymentProcessEnvironment(request, {
      PATH: "preserved", AWS_ACCESS_KEY_ID: "unused", AWS_SECRET_ACCESS_KEY: "unused",
      AWS_SESSION_TOKEN: "unused", AWS_ROLE_ARN: "unused", AWS_ENDPOINT_URL: "unused",
      AWS_DEFAULT_REGION: "us-east-1", AWS_PROFILE: "production", CDK_CONTEXT_JSON: "unused",
      CDK_DEFAULT_ACCOUNT: productionTarget.account, NODE_ENV: "development"
    });
    expect(environment).to.deep.equal({
      PATH: "preserved", NODE_ENV: "development", AWS_EC2_METADATA_DISABLED: "true",
      AWS_PROFILE: "infralens-test-admin", AWS_REGION: "eu-central-1", AWS_DEFAULT_REGION: "eu-central-1",
      AWS_SDK_LOAD_CONFIG: "1"
    });
    expect(deploymentProcessEnvironment({ ...request, command: "synth" }, {})).to.deep.equal({ AWS_EC2_METADATA_DISABLED: "true" });
  });

  it("rejects a substituted stack, account, region, extra stack or unresolved lookup in the assembly", () => {
    expect(() => verifyAssembly(assembly(), testTarget)).not.to.throw();
    const defaultStackName = assembly();
    Reflect.deleteProperty(defaultStackName.artifacts.InfraLensTestStack.properties, "stackName");
    expect(() => verifyAssembly(defaultStackName, testTarget)).not.to.throw();
    const renamedStack = assembly();
    renamedStack.artifacts.InfraLensTestStack.properties.stackName = "CDKToolkit";
    expect(() => verifyAssembly(renamedStack, testTarget)).to.throw("Synthesized assembly");
    expect(() => verifyAssembly(assembly(), productionTarget)).to.throw("Synthesized assembly");
    for (const environment of ["aws://609124256824/eu-central-1", "aws://230944684535/us-east-1"]) {
      const value = assembly(); value.artifacts.InfraLensTestStack.environment = environment;
      expect(() => verifyAssembly(value, testTarget)).to.throw("Synthesized assembly");
    }
    expect(() => verifyAssembly({ ...assembly(), missing: [{}] }, testTarget)).to.throw();
    expect(() => verifyAssembly({ artifacts: { ...assembly().artifacts, CDKToolkit: assembly().artifacts.InfraLensTestStack } }, testTarget)).to.throw();
  });

  for (const command of ["synth", "preflight", "diff", "deploy"]) {
    it(`runs only the expected steps for ${command} using mocked AWS and CDK processes`, () => {
      const directory = mkdtempSync(join(tmpdir(), "infralens-deployment-"));
      const calls: ProcessCall[] = [];
      try {
        runDeploymentWorkflow([command, ...testOptions], (call) => {
          calls.push(call);
          if (call.args[0] === "sts") return JSON.stringify({ Account: testTarget.account });
          if (call.args[0] === "cloudformation") return JSON.stringify({ Stacks: [{
            StackId: "arn:aws:cloudformation:eu-central-1:230944684535:stack/CDKToolkit/example",
            StackStatus: "CREATE_COMPLETE"
          }] });
          if (call.env.CDK_OUTDIR) {
            mkdirSync(call.env.CDK_OUTDIR, { recursive: true });
            writeFileSync(join(call.env.CDK_OUTDIR, "manifest.json"), JSON.stringify(assembly()));
          }
          return "";
        }, directory);
        if (command === "synth") {
          expect(calls).to.have.length(1);
          expect(calls[0].env.AWS_PROFILE).to.equal(undefined);
        } else if (command === "preflight") {
          expect(calls).to.have.length(2);
        } else {
          expect(calls).to.have.length(4);
          const operational = calls[3];
          expect(operational.args.slice(1, 3)).to.deep.equal([command, "InfraLensTestStack"]);
          expect(operational.env.AWS_REGION).to.equal(testTarget.region);
          expect(operational.env.AWS_PROFILE).to.equal(testTarget.profile);
          if (command === "diff") {
            expect(operational.args).to.include.members(["--method", "template"]);
          } else {
            expect(operational.args).to.include.members(["--outputs-file", deploymentPaths(testTarget, directory).outputs]);
          }
        }
      } finally {
        // directory is the exact new path returned by mkdtempSync, never a user-supplied path.
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("stores output files separately and generates both test frontends with the same test Cognito", () => {
    expect(deploymentPaths(testTarget, "/cdk").outputs).not.to.equal(deploymentPaths(productionTarget, "/cdk").outputs);
    const values = outputFixture(testTarget);
    const configurations = createFrontendConfigurations(testTarget, { InfraLensTestStack: values });
    expect(Object.keys(configurations)).to.deep.equal(["aws-test-hosted", "aws-test-local"]);
    expect(configurations["aws-test-local"]).to.include("VITE_INFRALENS_COGNITO_REDIRECT_URI=http://localhost:5173/auth/callback");
    for (const content of Object.values(configurations)) {
      expect(content).to.include("VITE_INFRALENS_AUTH_ENABLED=true");
      expect(content).to.include(`VITE_INFRALENS_COGNITO_DOMAIN=${values.CognitoHostedDomain}`);
      expect(content).not.to.include(productionTarget.account);
    }
    const prodConfigs = createFrontendConfigurations(productionTarget, { InfraLensProdStack: outputFixture(productionTarget) });
    expect(Object.keys(prodConfigs)).to.deep.equal(["aws-production-hosted"]);
    expect(() => createFrontendConfigurations(productionTarget, { InfraLensTestStack: values })).to.throw("do not match");
    expect(() => createFrontendConfigurations(testTarget, { InfraLensTestStack: { ...values, CognitoCallbackUrls: "http://wrong" } })).to.throw("do not match");
  });
});

function outputFixture(target: typeof testTarget) {
  const origins = ["https://example.cloudfront.net", ...target.additionalFrontendOrigins];
  return {
    DeploymentAccount: target.account, DeploymentRegion: target.region,
    DeploymentStackName: target.stackName, DeploymentEnvironment: target.name,
    FrontendOrigin: origins[0], AllowedFrontendOrigins: origins.join(","),
    CognitoCallbackUrls: origins.map((origin) => `${origin}/auth/callback`).join(","),
    CognitoLogoutUrls: origins.map((origin) => `${origin}/`).join(","),
    AnalysisApiBaseUrl: `https://example.execute-api.${target.region}.amazonaws.com/${target.name}/`,
    CognitoHostedDomain: `https://${target.cognitoDomainPrefix}.auth.${target.region}.amazoncognito.com`,
    CognitoWebClientId: "exampleclient", CognitoUserPoolId: `${target.region}_example`
  };
}
