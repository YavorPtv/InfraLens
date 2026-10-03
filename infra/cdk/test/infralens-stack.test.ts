import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Match, Template } from "aws-cdk-lib/assertions";
import { expect } from "chai";
import { describe, it } from "mocha";
import { addAnalysisApiRoutes, InfraLensStack } from "../src/infralens-stack";
import { resolveDeploymentTarget } from "../src/deployment-target";

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
      target: resolveDeploymentTarget("production"),
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
    const lambdaLoggingPolicy = Object.values(template.findResources("AWS::IAM::Policy")).find(
      (resource) => JSON.stringify(resource).includes("logs:PutLogEvents")
    );
    expect(lambdaLoggingPolicy).not.to.equal(undefined);
    const statements = lambdaLoggingPolicy!.Properties.PolicyDocument.Statement as Array<{
      Action: string | string[];
      Resource: unknown;
    }>;
    const logStatement = statements.find((statement) =>
      JSON.stringify(statement.Action).includes("logs:PutLogEvents")
    );
    expect(JSON.stringify(logStatement)).not.to.contain('"Resource":"*"');
    const awsStatements = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes("cloudformation:")
    );
    expect(awsStatements).to.have.length(1);
    expect(awsStatements[0]).to.deep.include({
      Action: "cloudformation:ValidateTemplate",
      Resource: "*"
    });
    expect(statements.flatMap((statement) => statement.Action)).to.have.members([
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "cloudformation:ValidateTemplate",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "s3:GetObject",
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:DeleteObject"
    ]);
    const storageStatements = statements.filter((statement) => {
      const actions = JSON.stringify(statement.Action);
      return actions.includes("dynamodb:") || actions.includes("s3:");
    });
    for (const statement of storageStatements) {
      expect(statement.Resource).not.to.equal("*");
      expect(JSON.stringify(statement.Action)).not.to.match(/(?:dynamodb|s3):\*/);
    }
    template.resourceCountIs("AWS::DynamoDB::Table", 2);
    const tables = template.findResources("AWS::DynamoDB::Table");
    for (const table of Object.values(tables)) {
      expect(table.DeletionPolicy).to.equal("Retain");
      expect(table.Properties.GlobalSecondaryIndexes).to.equal(undefined);
      expect(table.Properties.SSESpecification.SSEEnabled).to.equal(true);
    }
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: 7,
            TagFilters: [{ Key: "retention", Value: "input" }]
          })
        ])
      }
    });
    const methods = Object.values(template.findResources("AWS::ApiGateway::Method"));
    const protectedMethods = methods.filter(
      (method) => method.Properties.Integration?.Type === "AWS_PROXY"
    );
    expect(protectedMethods.length).to.equal(14);
    expect(
      protectedMethods.every(
        (method) => method.Properties.AuthorizationType === "COGNITO_USER_POOLS"
      )
    ).to.equal(true);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ INFRALENS_CLOUDFORMATION_VALIDATION: "true" }) }
    });
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

  it("requires a valid Cognito domain prefix for every hosted target", () => {
    const app = new cdk.App();

    expect(
      () => new InfraLensStack(app, "InvalidProductionStack", {
        target: { ...resolveDeploymentTarget("production"), cognitoDomainPrefix: "" }
      })
    ).to.throw("Invalid Cognito domain prefix");
  });

  it("rejects reserved Cognito domain terms before deployment", () => {
    const app = new cdk.App();

    expect(
      () =>
        new InfraLensStack(app, "ReservedDomainStack", {
          target: { ...resolveDeploymentTarget("production"), cognitoDomainPrefix: "infralens-cognito" }
        })
    ).to.throw("without aws, amazon, or cognito");
  });

  it("leaves reserved concurrency unset when the account quota is unknown", function () {
    const app = new cdk.App();
    const stack = new InfraLensStack(app, "DefaultConcurrencyStack", { target: resolveDeploymentTarget("test") });
    const functions = Template.fromStack(stack).findResources("AWS::Lambda::Function");
    const analysisFunction = Object.values(functions)[0];

    expect(analysisFunction.Properties).not.to.have.property("ReservedConcurrentExecutions");
  });

  for (const targetName of ["test", "production"] as const) {
    it(`isolates ${targetName} resources and aligns API, Lambda, Cognito and frontend outputs`, () => {
      const target = resolveDeploymentTarget(targetName);
      const other = resolveDeploymentTarget(targetName === "test" ? "production" : "test");
      const stack = new InfraLensStack(new cdk.App(), target.stackName, { target });
      const template = Template.fromStack(stack);
      const json = template.toJSON();
      expect(stack.account).to.equal(target.account);
      expect(stack.region).to.equal(target.region);
      expect(stack.stackName).to.equal(target.stackName);
      const serialized = JSON.stringify(json);
      expect(serialized).not.to.include(other.account);
      expect(serialized).not.to.include(other.stackName);
      expect(serialized).not.to.include(other.cognitoDomainPrefix);
      expect(serialized).not.to.include("Fn::ImportValue");
      template.resourceCountIs("AWS::Cognito::UserPool", 1);
      template.resourceCountIs("AWS::DynamoDB::Table", 2);
      template.resourceCountIs("AWS::S3::Bucket", 2);
      template.hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: target.cognitoDomainPrefix });
      const resources = json.Resources as Record<string, SynthesizedResource>;
      const distributionId = Object.entries(resources).find(([, resource]) => resource.Type === "AWS::CloudFront::Distribution")![0];
      const cloudfrontOrigin = { "Fn::Join": ["", ["https://", { "Fn::GetAtt": [distributionId, "DomainName"] }]] };
      const client = Object.values(template.findResources("AWS::Cognito::UserPoolClient"))[0].Properties;
      const callbacks = client.CallbackURLs as unknown[];
      const logouts = client.LogoutURLs as unknown[];
      expect(callbacks).to.have.length(targetName === "test" ? 2 : 1);
      expect(logouts).to.have.length(callbacks.length);
      expect(callbacks[0]).to.deep.equal({ "Fn::Join": ["", ["https://", { "Fn::GetAtt": [distributionId, "DomainName"] }, "/auth/callback"]] });
      expect(logouts[0]).to.deep.equal({ "Fn::Join": ["", ["https://", { "Fn::GetAtt": [distributionId, "DomainName"] }, "/"]] });
      const variables = Object.values(template.findResources("AWS::Lambda::Function"))[0].Properties.Environment.Variables;
      expect(variables.INFRALENS_ENVIRONMENT).to.equal("production");
      expect(variables.INFRALENS_HISTORY_ADAPTER).to.equal("aws");
      expect(variables).not.to.have.property("INFRALENS_LOCAL_OWNER");
      for (const [variable, resourceType] of [
        ["INFRALENS_PROJECTS_TABLE", "AWS::DynamoDB::Table"],
        ["INFRALENS_RUNS_TABLE", "AWS::DynamoDB::Table"],
        ["INFRALENS_ARTIFACT_BUCKET", "AWS::S3::Bucket"]
      ]) {
        expect(resources[variables[variable].Ref].Type).to.equal(resourceType);
      }
      expect(json.Outputs.FrontendOrigin.Value).to.deep.equal(cloudfrontOrigin);
      expect(json.Outputs.AllowedFrontendOrigins.Value).to.deep.equal(variables.INFRALENS_CORS_ORIGINS);
      if (targetName === "test") {
        expect(callbacks[1]).to.equal("http://localhost:5173/auth/callback");
        expect(logouts[1]).to.equal("http://localhost:5173/");
        expect(JSON.stringify(variables.INFRALENS_CORS_ORIGINS)).to.include(",http://localhost:5173");
      } else {
        expect(serialized).not.to.include("localhost");
        expect(variables.INFRALENS_CORS_ORIGINS).to.deep.equal(cloudfrontOrigin);
      }
      const methods = Object.values(template.findResources("AWS::ApiGateway::Method"));
      const protectedMethods = methods.filter((method) => method.Properties.Integration?.Type === "AWS_PROXY");
      expect(protectedMethods).to.have.length(14);
      const authorizerId = Object.keys(template.findResources("AWS::ApiGateway::Authorizer"))[0];
      for (const method of protectedMethods) {
        expect(method.Properties.AuthorizationType).to.equal("COGNITO_USER_POOLS");
        expect(method.Properties.AuthorizerId).to.deep.equal({ Ref: authorizerId });
        expect(method.Properties.AuthorizationScopes).to.deep.equal(["openid"]);
      }
      const preflights = methods.filter((method) => method.Properties.HttpMethod === "OPTIONS");
      expect(preflights.length).to.be.greaterThan(10);
      for (const method of preflights) {
        expect(method.Properties.AuthorizationType).to.equal("NONE");
        const response = method.Properties.Integration.IntegrationResponses[0];
        expect(JSON.stringify(response.ResponseParameters)).not.to.include("'*'");
        expect(JSON.stringify(response.ResponseParameters)).to.include(distributionId);
        expect(response.ResponseParameters["method.response.header.Access-Control-Allow-Methods"]).to.equal("'GET,OPTIONS,POST,PATCH,DELETE'");
        if (targetName === "test") {
          expect(response.ResponseTemplates["application/json"]).to.include('$origin == "http://localhost:5173"');
        }
      }
      for (const key of ["DeploymentAccount", "DeploymentRegion", "DeploymentStackName", "AnalysisApiBaseUrl", "ProjectsTableName", "RunsTableName", "ArtifactBucketName", "FrontendBucketName", "FrontendDistributionId", "CognitoUserPoolId", "CognitoWebClientId", "CognitoHostedDomain", "CognitoCallbackUrls", "CognitoLogoutUrls"]) {
        expect(json.Outputs).to.have.property(key);
      }
      for (const type of ["AWS::DynamoDB::Table", "AWS::S3::Bucket", "AWS::Cognito::UserPool", "AWS::Logs::LogGroup"]) {
        for (const resource of Object.values(template.findResources(type))) {
          expect(resource.DeletionPolicy).to.equal("Retain");
        }
      }
      expect(serialized).not.to.include("Custom::S3AutoDeleteObjects");
    });
  }
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
      resource.Type === "AWS::ApiGateway::Resource" && resource.Properties?.PathPart === pathPart
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
