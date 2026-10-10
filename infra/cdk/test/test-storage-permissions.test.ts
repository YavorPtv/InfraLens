import { expect } from "chai";
import { describe, it } from "mocha";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestStoragePolicy, prepareTestStoragePolicy } from "../src/test-storage-permissions";

function testOutputs() {
  const origin = "https://example.cloudfront.net";
  return { InfraLensTestStack: {
    DeploymentEnvironment: "test", DeploymentAccount: "230944684535", DeploymentRegion: "eu-central-1",
    DeploymentStackName: "InfraLensTestStack", AnalysisApiBaseUrl: "https://example.execute-api.eu-central-1.amazonaws.com/test/",
    FrontendOrigin: origin, AllowedFrontendOrigins: `${origin},http://localhost:5173`,
    CognitoCallbackUrls: `${origin}/auth/callback,http://localhost:5173/auth/callback`,
    CognitoLogoutUrls: `${origin}/,http://localhost:5173/`, CognitoUserPoolId: "eu-central-1_example",
    CognitoWebClientId: "exampleclient", CognitoHostedDomain: "https://infralens-test-230944684535-euc1.auth.eu-central-1.amazoncognito.com",
    ProjectsTableName: "InfraLensTestStack-ProjectsTableABC-example",
    RunsTableName: "InfraLensTestStack-RunsTableABC-example",
    ArtifactBucketName: "infralensteststack-artifactbucketabc-example"
  } };
}

describe("offline storage-test permission preparation", () => {
  it("rejects missing, invalid and production targets", () => {
    for (const target of [undefined, "local", "development", "production"]) {
      expect(() => createTestStoragePolicy(target, testOutputs())).to.throw();
    }
  });

  it("rejects mismatched identity and foreign resources before granting access", () => {
    for (const change of [
      { DeploymentAccount: "609124256824" }, { DeploymentRegion: "us-east-1" },
      { DeploymentStackName: "InfraLensProdStack" }, { ProjectsTableName: "InfraLensProdStack-ProjectsTableABC-example" },
      { RunsTableName: "other-table" }, { ArtifactBucketName: "other-bucket" }
    ]) {
      const outputs = testOutputs();
      Object.assign(outputs.InfraLensTestStack, change);
      expect(() => createTestStoragePolicy("test", outputs)).to.throw();
    }
    const outputs = { ...testOutputs(), InfraLensProdStack: {} };
    expect(() => createTestStoragePolicy("test", outputs)).to.throw();
  });

  it("limits preflight to caller identity and the exact regional test stack", () => {
    const policy = createTestStoragePolicy("test", testOutputs());
    const caller = policy.Statement.find(statement => statement.Sid === "VerifyCallerIdentity")!;
    const stack = policy.Statement.find(statement => statement.Sid === "ReadTestStackOutputs")!;
    expect(caller.Action).to.deep.equal(["sts:GetCallerIdentity"]);
    expect(stack.Action).to.deep.equal(["cloudformation:DescribeStacks"]);
    expect(stack.Resource).to.equal("arn:aws:cloudformation:eu-central-1:230944684535:stack/InfraLensTestStack/*");
    expect(stack.Condition).to.deep.equal({ StringEquals: { "aws:RequestedRegion": "eu-central-1" } });
  });

  it("restricts table operations to all test-owner keys, including transactional puts and cleanup", () => {
    const policy = createTestStoragePolicy("test", testOutputs());
    for (const [sid, table, keys] of [
      ["TestOwnerProjectRecords", testOutputs().InfraLensTestStack.ProjectsTableName, "OWNER#test-*"],
      ["TestOwnerRunRecords", testOutputs().InfraLensTestStack.RunsTableName, "OWNER#test-*#PROJECT#*"]
    ]) {
      const statement = policy.Statement.find(item => item.Sid === sid)!;
      expect(statement.Resource).to.equal(`arn:aws:dynamodb:eu-central-1:230944684535:table/${table}`);
      expect(statement.Action).to.have.members(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"]);
      expect(statement.Condition).to.deep.equal({
        StringEquals: { "aws:RequestedRegion": "eu-central-1" },
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [keys] },
        Null: { "dynamodb:LeadingKeys": "false" }
      });
    }
  });

  it("permits tagged artifacts and signed downloads only in the test-owner object namespace", () => {
    const policy = createTestStoragePolicy("test", testOutputs());
    const statement = policy.Statement.find(item => item.Sid === "TestOwnerArtifacts")!;
    expect(statement.Resource).to.equal("arn:aws:s3:::infralensteststack-artifactbucketabc-example/owners/test-*/projects/*/runs/*");
    expect(statement.Action).to.have.members(["s3:GetObject", "s3:PutObject", "s3:PutObjectTagging", "s3:DeleteObject"]);
    expect(statement.Condition).to.deep.equal({
      StringEquals: { "aws:RequestedRegion": "eu-central-1", "s3:ResourceAccount": "230944684535" }
    });
  });

  it("does not grant deployment, administration, scans, bucket listing or production access", () => {
    const policy = createTestStoragePolicy("test", testOutputs());
    const actions = policy.Statement.flatMap(statement => statement.Action);
    expect(actions).to.have.members([
      "sts:GetCallerIdentity", "cloudformation:DescribeStacks",
      "dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem",
      "dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem",
      "s3:GetObject", "s3:PutObject", "s3:PutObjectTagging", "s3:DeleteObject"
    ]);
    expect(policy.Statement.filter(statement => statement.Resource === "*").map(statement => statement.Sid))
      .to.deep.equal(["VerifyCallerIdentity"]);
    expect(JSON.stringify(policy)).not.to.include("609124256824");
    expect(JSON.stringify(policy)).not.to.include("InfraLensProdStack");
    expect(Buffer.byteLength(JSON.stringify(policy), "utf8")).to.be.lessThan(10240);
  });

  it("fails invalid CLI options before accessing files", () => {
    for (const args of [
      [], ["--target", "production"], ["--target", "test", "--target", "test"],
      ["--target", "test", "--outputs"], ["--target", "test", "--profile", "admin"]
    ]) {
      expect(() => prepareTestStoragePolicy(args, "/missing-output-directory")).to.throw();
    }
  });

  it("writes a readable policy offline and preserves the source deployment outputs", () => {
    const directory = mkdtempSync(join(tmpdir(), "infralens-storage-policy-"));
    try {
      const outputsPath = join(directory, "cdk-outputs.test.json");
      const source = `\uFEFF${JSON.stringify(testOutputs())}`;
      writeFileSync(outputsPath, source, "utf8");
      const result = prepareTestStoragePolicy(["--target", "test"], directory);
      expect(result).to.equal(join(directory, "cdk.out", "test-storage.policy.json"));
      expect(JSON.parse(readFileSync(result, "utf8"))).to.deep.equal(createTestStoragePolicy("test", testOutputs()));
      expect(readFileSync(outputsPath, "utf8")).to.equal(source);
      expect(() => prepareTestStoragePolicy(["--target", "test", "--outputs", result], directory)).to.throw("separate");
      const invalidPath = join(directory, "wrong-account.json");
      const invalid = testOutputs();
      invalid.InfraLensTestStack.DeploymentAccount = "609124256824";
      writeFileSync(invalidPath, JSON.stringify(invalid), "utf8");
      rmSync(result);
      expect(() => prepareTestStoragePolicy(["--target", "test", "--outputs", invalidPath], directory)).to.throw();
      expect(existsSync(result)).to.equal(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
