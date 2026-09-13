import { expect } from "chai";
import type { CfnTemplate, CfnValue } from "@infralens/shared";
import { analyzeTemplate } from "../src";

describe("evidence-driven failure handling and invocation rules", () => {
  for (const principal of ["s3.amazonaws.com", "sns.amazonaws.com", "events.amazonaws.com", "apigateway.amazonaws.com"]) {
    it(`flags unrestricted ${principal} invocation and accepts explicit source evidence`, () => {
      const properties = { Action: "lambda:InvokeFunction", Principal: principal, FunctionName: { Ref: "Function" } };
      expect(invokeFindings(properties)).to.have.lengthOf(1);
      expect(invokeFindings({ ...properties, SourceAccount: "123456789012" })).to.deep.equal([]);
      expect(invokeFindings({ ...properties, SourceArn: { "Fn::Sub": "arn:${AWS::Partition}:sns:${AWS::Region}:${AWS::AccountId}:topic" } })).to.deep.equal([]);
    });
  }
  for (const properties of [
    { Action: "lambda:InvokeFunction", Principal: "123456789012" },
    { Action: "lambda:InvokeFunctionUrl", Principal: "*" },
    { Action: "lambda:InvokeFunction", Principal: { Ref: "ServicePrincipal" } }
  ] as Record<string, CfnValue>[]) it(`does not guess about unsupported permission ${JSON.stringify(properties)}`, () => {
    expect(invokeFindings(properties)).to.deep.equal([]);
  });

  for (const [type, properties] of [
    ["AWS::Lambda::Function", { DeadLetterConfig: { TargetArn: { "Fn::GetAtt": ["Failures", "Arn"] } } }],
    ["AWS::Lambda::EventInvokeConfig", { DestinationConfig: { OnFailure: { Destination: { "Fn::GetAtt": ["Failures", "Arn"] } } } }],
    ["AWS::Lambda::EventSourceMapping", { DestinationConfig: { OnFailure: { Destination: { "Fn::GetAtt": ["Failures", "Arn"] } } } }],
    ["AWS::Events::Rule", { Targets: [{ Id: "Target", DeadLetterConfig: { Arn: { "Fn::GetAtt": ["Failures", "Arn"] } } }] }],
    ["AWS::SNS::Subscription", { RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": ["Failures", "Arn"] } } }]
  ] as [string, Record<string, CfnValue>][]) it(`recognizes a queue used for failures by ${type}`, () => {
    const report = analyzeTemplate(JSON.stringify({ Resources: { Failures: { Type: "AWS::SQS::Queue" }, Source: { Type: type, Properties: properties }, Ordinary: { Type: "AWS::SQS::Queue" } } }));
    expect(report.findings.filter(value => value.ruleId === "SQS_MISSING_DLQ").map(value => value.resourceId)).to.deep.equal(["Ordinary"]);
  });

  it("only accepts a function DLQ for an exactly matched current function qualifier", () => {
    const template: CfnTemplate = { Resources: {
      Function: { Type: "AWS::Lambda::Function", Properties: { FunctionName: "worker", DeadLetterConfig: { TargetArn: "arn:aws:sqs:eu-west-1:123456789012:failures" } } },
      Config: { Type: "AWS::Lambda::EventInvokeConfig", Properties: { FunctionName: "worker", Qualifier: "$LATEST" } }
    } };
    const failures = () => analyzeTemplate(JSON.stringify(template)).findings.filter(value => value.ruleId === "LAMBDA_DEAD_LETTER_CONFIG_MISSING");
    expect(failures()).to.deep.equal([]);
    template.Resources.Config.Properties!.Qualifier = "live";
    expect(failures()).to.have.lengthOf(1);
    template.Resources.Config.Properties!.Qualifier = "$LATEST";
    template.Resources.Config.Properties!.FunctionName = "external";
    expect(failures()).to.have.lengthOf(1);
    template.Resources.Config.Properties!.FunctionName = { Ref: "Function" };
    delete template.Resources.Function.Properties!.DeadLetterConfig;
    expect(failures()).to.have.lengthOf(1);
  });
});

function invokeFindings(properties: Record<string, CfnValue>) {
  return analyzeTemplate(JSON.stringify({ Resources: { Permission: { Type: "AWS::Lambda::Permission", Properties: properties } } })).findings.filter(value => value.ruleId === "LAMBDA_SERVICE_PERMISSION_UNSCOPED");
}
