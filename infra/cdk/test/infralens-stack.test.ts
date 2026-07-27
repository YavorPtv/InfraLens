import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { expect } from "chai";
import { describe, it } from "mocha";
import { addAnalysisApiRoutes } from "../src/infralens-stack";

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
            "method.response.header.Access-Control-Allow-Headers": "'Content-Type'",
            "method.response.header.Access-Control-Allow-Methods": "'GET,OPTIONS,POST'",
            "method.response.header.Access-Control-Allow-Origin": "'*'"
          },
          StatusCode: "204"
        }
      ]
    });
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
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "OPTIONS", "POST"],
      allowOrigins: apigateway.Cors.ALL_ORIGINS
    }
  });

  addAnalysisApiRoutes(api, analysisFunction);

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
