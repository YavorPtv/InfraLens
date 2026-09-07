import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Match, Template } from "aws-cdk-lib/assertions";
import { expect } from "chai";
import { describe, it } from "mocha";
import { addAnalysisApiRoutes, InfraLensStack } from "../src/infralens-stack";

interface SynthesizedResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

describe("InfraLensStack", () => {
  it("exposes POST /diff through the analysis Lambda", () => {
    const template = synthesizeTemplate();
    const diffResource = findApiResource(template, "diff");
    const diffMethod = findApiMethod(template, diffResource.logicalId, "POST");

    expect(diffMethod.Properties?.Integration).to.deep.include({
      IntegrationHttpMethod: "POST",
      Type: "AWS_PROXY"
    });
  });

  it("configures CORS preflight for /diff", () => {
    const template = synthesizeTemplate();
    const diffResource = findApiResource(template, "diff");
    const optionsMethod = findApiMethod(template, diffResource.logicalId, "OPTIONS");

    expect(optionsMethod.Properties?.Integration).to.deep.include({
      Type: "MOCK"
    });
    expect(optionsMethod.Properties?.Integration).to.deep.include({
      IntegrationResponses: [
        {
          ResponseParameters: {
            "method.response.header.Access-Control-Allow-Headers": "'Authorization,Content-Type'",
            "method.response.header.Access-Control-Allow-Methods": "'GET,OPTIONS,POST'",
            "method.response.header.Access-Control-Allow-Origin": "'https://app.example.com'",
            "method.response.header.Vary": "'Origin'"
          },
          StatusCode: "204"
        }
      ]
    });
  });

  it("exposes POST /apply through the analysis Lambda", () => {
    const template = synthesizeTemplate();
    const applyResource = findApiResource(template, "apply");
    const applyMethod = findApiMethod(template, applyResource.logicalId, "POST");

    expect(applyMethod.Properties?.Integration).to.deep.include({
      IntegrationHttpMethod: "POST",
      Type: "AWS_PROXY"
    });
  });

  it("protects every analysis route with the Cognito authorizer", () => {
    const template = synthesizeTemplate();

    for (const path of ["analyze", "diff", "apply"]) {
      const resource = findApiResource(template, path);
      const method = findApiMethod(template, resource.logicalId, "POST");
      expect(method.Properties).to.include({ AuthorizationType: "COGNITO_USER_POOLS" });
      expect(method.Properties?.AuthorizationScopes).to.deep.equal(["openid"]);
      expect(method.Properties?.AuthorizerId).to.not.equal(undefined);
    }
  });

  it("configures production authentication and operational safeguards", function () {
    const app = new cdk.App();
    const stack = new InfraLensStack(app, "ProductionStack", {
      alertEmail: "alerts@example.com",
      cognitoDomainPrefix: "infralens-test-protected-api",
      environmentName: "production",
      lambdaReservedConcurrency: 5,
      monthlyBudgetUsd: 10
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: Match.arrayWith(["openid", "email"]),
      GenerateSecret: false,
      PreventUserExistenceErrors: "ENABLED"
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogFormat: "JSON" },
      MemorySize: 512,
      ReservedConcurrentExecutions: 5,
      Timeout: 30
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Effect: "Allow",
            Resource: Match.anyValue()
          })
        ])
      }
    });
    const lambdaLoggingPolicy = Object.values(
      template.findResources("AWS::IAM::Policy")
    ).find((resource) => JSON.stringify(resource).includes("logs:PutLogEvents"));
    expect(lambdaLoggingPolicy).not.to.equal(undefined);
    expect(JSON.stringify(lambdaLoggingPolicy)).not.to.contain('"Resource":"*"');
    expect(JSON.stringify(lambdaLoggingPolicy)).not.to.contain('"Action":"*"');
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      AccessLogSetting: Match.objectLike({
        DestinationArn: Match.anyValue(),
        Format: Match.stringLikeRegexp("requestId")
      }),
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          DataTraceEnabled: false,
          LoggingLevel: "INFO",
          MetricsEnabled: true,
          ThrottlingBurstLimit: 5,
          ThrottlingRateLimit: 2
        })
      ]),
      StageName: "production"
    });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
  });

  it("requires a Cognito domain prefix in production", () => {
    const app = new cdk.App();

    expect(
      () => new InfraLensStack(app, "InvalidProductionStack", { environmentName: "production" })
    ).to.throw("cognitoDomainPrefix is required");
  });

  it("rejects reserved Cognito domain terms before deployment", () => {
    const app = new cdk.App();

    expect(
      () =>
        new InfraLensStack(app, "ReservedDomainStack", {
          cognitoDomainPrefix: "infralens-cognito",
          environmentName: "production"
        })
    ).to.throw("must not contain the reserved terms aws, amazon, or cognito");
  });

  it("leaves reserved concurrency unset when the account quota is unknown", function () {
    const app = new cdk.App();
    const stack = new InfraLensStack(app, "DefaultConcurrencyStack");
    const functions = Template.fromStack(stack).findResources("AWS::Lambda::Function");
    const analysisFunction = Object.values(functions)[0];

    expect(analysisFunction.Properties).not.to.have.property("ReservedConcurrentExecutions");
  });
});

function synthesizeTemplate(): Record<string, SynthesizedResource> {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const analysisFunction = new lambda.Function(stack, "AnalysisApiFunction", {
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
    handler: "index.handler",
    runtime: lambda.Runtime.NODEJS_20_X
  });
  const api = new apigateway.RestApi(stack, "AnalysisApi", {
    defaultCorsPreflightOptions: {
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "OPTIONS", "POST"],
      allowOrigins: ["https://app.example.com"]
    }
  });
  const userPool = new cognito.UserPool(stack, "UserPool", {
    selfSignUpEnabled: false
  });
  const authorizer = new apigateway.CognitoUserPoolsAuthorizer(stack, "Authorizer", {
    cognitoUserPools: [userPool]
  });

  addAnalysisApiRoutes(api, analysisFunction, {
    authorizer,
    authorizationScopes: ["openid"]
  });

  const template = Template.fromStack(stack).toJSON() as {
    Resources: Record<string, SynthesizedResource>;
  };

  return template.Resources;
}

function findApiResource(
  resources: Record<string, SynthesizedResource>,
  pathPart: string
): { logicalId: string; resource: SynthesizedResource } {
  const resourceEntry = Object.entries(resources).find(
    ([, resource]) =>
      resource.Type === "AWS::ApiGateway::Resource" &&
      resource.Properties?.PathPart === pathPart
  );

  expect(resourceEntry, `API resource ${pathPart} should exist`).to.not.equal(undefined);

  const [logicalId, resource] = resourceEntry as [string, SynthesizedResource];
  return { logicalId, resource };
}

function findApiMethod(
  resources: Record<string, SynthesizedResource>,
  resourceLogicalId: string,
  httpMethod: string
): SynthesizedResource {
  const method = Object.values(resources).find(
    (resource) =>
      resource.Type === "AWS::ApiGateway::Method" &&
      resource.Properties?.HttpMethod === httpMethod &&
      referencesResource(resource.Properties.ResourceId, resourceLogicalId)
  );

  expect(method, `${httpMethod} method should exist`).to.not.equal(undefined);

  return method as SynthesizedResource;
}

function referencesResource(value: unknown, logicalId: string): boolean {
  return JSON.stringify(value) === JSON.stringify({ Ref: logicalId });
}
