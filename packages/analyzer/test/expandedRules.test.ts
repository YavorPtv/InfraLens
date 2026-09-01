import { expect } from "chai";
import type { CfnTemplate, Finding } from "@infralens/shared";
import { analyzeTemplate } from "../src";

describe("expanded analyzer rules", () => {
  it("flags an asynchronous Lambda config without an on-failure destination", () => {
    const findings = findingsFor({
      AsyncConfig: {
        Type: "AWS::Lambda::EventInvokeConfig",
        Properties: { FunctionName: "worker", Qualifier: "$LATEST" }
      }
    });

    expect(rule(findings, "LAMBDA_DEAD_LETTER_CONFIG_MISSING")?.evidencePath).to.equal(
      "Resources.AsyncConfig.Properties.DestinationConfig.OnFailure.Destination"
    );
  });

  it("does not flag an asynchronous Lambda config with an on-failure destination", () => {
    const findings = findingsFor({
      AsyncConfig: {
        Type: "AWS::Lambda::EventInvokeConfig",
        Properties: {
          DestinationConfig: { OnFailure: { Destination: "arn:aws:sqs:region:account:dlq" } }
        }
      }
    });

    expect(rule(findings, "LAMBDA_DEAD_LETTER_CONFIG_MISSING")).to.equal(undefined);
  });

  it("flags only the deterministic zero reserved-concurrency condition", () => {
    const findings = findingsFor({
      DisabledFunction: {
        Type: "AWS::Lambda::Function",
        Properties: { ReservedConcurrentExecutions: 0, TracingConfig: { Mode: "Active" } }
      },
      LimitedFunction: {
        Type: "AWS::Lambda::Function",
        Properties: { ReservedConcurrentExecutions: 1, TracingConfig: { Mode: "Active" } }
      }
    });

    expect(
      resourcesFor(findings, "LAMBDA_RESERVED_CONCURRENCY_RISK")
    ).to.deep.equal(["DisabledFunction"]);
  });

  it("flags S3 buckets without enabled versioning", () => {
    const findings = findingsFor({
      Unversioned: { Type: "AWS::S3::Bucket" },
      Suspended: {
        Type: "AWS::S3::Bucket",
        Properties: { VersioningConfiguration: { Status: "Suspended" } }
      },
      Versioned: {
        Type: "AWS::S3::Bucket",
        Properties: { VersioningConfiguration: { Status: "Enabled" } }
      }
    });

    expect(resourcesFor(findings, "S3_VERSIONING_DISABLED")).to.deep.equal([
      "Unversioned",
      "Suspended"
    ]);
  });

  it("flags SNS topics without explicit KMS encryption", () => {
    const findings = findingsFor({
      PlainTopic: { Type: "AWS::SNS::Topic" },
      EncryptedTopic: {
        Type: "AWS::SNS::Topic",
        Properties: { KmsMasterKeyId: "alias/aws/sns" }
      }
    });

    expect(resourcesFor(findings, "SNS_TOPIC_ENCRYPTION_MISSING")).to.deep.equal(["PlainTopic"]);
  });

  it("flags API Gateway stages without complete access logging", () => {
    const findings = findingsFor({
      UnloggedStage: { Type: "AWS::ApiGateway::Stage" },
      LoggedStage: {
        Type: "AWS::ApiGateway::Stage",
        Properties: {
          AccessLogSetting: {
            DestinationArn: "arn:aws:logs:region:account:log-group:api",
            Format: "$context.requestId"
          },
          TracingEnabled: true
        }
      }
    });

    expect(resourcesFor(findings, "API_GATEWAY_ACCESS_LOGGING_MISSING")).to.deep.equal([
      "UnloggedStage"
    ]);
  });

  it("flags API Gateway stages without active tracing at low severity", () => {
    const findings = findingsFor({
      Stage: { Type: "AWS::ApiGateway::Stage" }
    });

    expect(rule(findings, "API_GATEWAY_TRACING_DISABLED")).to.include({
      resourceId: "Stage",
      severity: "low"
    });
  });

  it("flags Lambda functions without active tracing at low severity", () => {
    const findings = findingsFor({
      PassiveFunction: {
        Type: "AWS::Lambda::Function",
        Properties: { TracingConfig: { Mode: "PassThrough" } }
      },
      TracedFunction: {
        Type: "AWS::Lambda::Function",
        Properties: { TracingConfig: { Mode: "Active" } }
      }
    });

    expect(resourcesFor(findings, "LAMBDA_TRACING_DISABLED")).to.deep.equal([
      "PassiveFunction"
    ]);
  });

  it("flags DynamoDB tables without deletion protection", () => {
    const findings = findingsFor({
      UnprotectedTable: { Type: "AWS::DynamoDB::Table" },
      ProtectedTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: { DeletionProtectionEnabled: true }
      }
    });

    expect(resourcesFor(findings, "DYNAMODB_DELETION_PROTECTION_DISABLED")).to.deep.equal([
      "UnprotectedTable"
    ]);
  });

  it("flags iam:PassRole on wildcard resources", () => {
    const findings = findingsFor({
      AppRole: roleWithActions(["iam:PassRole"], "*")
    });

    expect(rule(findings, "IAM_PASSROLE_WILDCARD")).to.include({
      resourceId: "AppRole",
      severity: "high"
    });
  });

  it("does not flag iam:PassRole when it is scoped to a role ARN", () => {
    const findings = findingsFor({
      AppRole: roleWithActions(["iam:PassRole"], "arn:aws:iam::123456789012:role/Worker")
    });

    expect(rule(findings, "IAM_PASSROLE_WILDCARD")).to.equal(undefined);
  });

  it("flags an explicit permission-mutation action on wildcard resources", () => {
    const findings = findingsFor({
      AppRole: roleWithActions(["iam:PutRolePolicy", "iam:GetRole"], "*")
    });
    const finding = rule(findings, "IAM_PRIVILEGE_ESCALATION_ACTIONS");

    expect(finding).to.include({ resourceId: "AppRole", severity: "high" });
    expect(finding?.explanation).to.include("iam:PutRolePolicy");
  });
});

function findingsFor(resources: CfnTemplate["Resources"]): Finding[] {
  return analyzeTemplate(JSON.stringify({ Resources: resources })).findings;
}

function rule(findings: Finding[], ruleId: string): Finding | undefined {
  return findings.find((finding) => finding.ruleId === ruleId);
}

function resourcesFor(findings: Finding[], ruleId: string): string[] {
  return findings
    .filter((finding) => finding.ruleId === ruleId)
    .map((finding) => finding.resourceId);
}

function roleWithActions(actions: string[], resource: string): CfnTemplate["Resources"][string] {
  return {
    Type: "AWS::IAM::Role",
    Properties: {
      Policies: [
        {
          PolicyName: "Access",
          PolicyDocument: {
            Statement: { Effect: "Allow", Action: actions, Resource: resource }
          }
        }
      ]
    }
  };
}
