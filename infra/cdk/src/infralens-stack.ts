import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { join } from "node:path";
import type { Construct } from "constructs";

export class InfraLensStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const frontendDistribution = new cloudfront.Distribution(this, "FrontendDistribution", {
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5)
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5)
        }
      ],
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      defaultRootObject: "index.html"
    });

    const analysisFunction = new nodejs.NodejsFunction(this, "AnalysisApiFunction", {
      architecture: lambda.Architecture.ARM_64,
      bundling: {
        minify: false,
        sourceMap: true,
        target: "node20"
      },
      depsLockFilePath: join(__dirname, "../../../package-lock.json"),
      entry: join(__dirname, "../../../apps/api/src/lambda.ts"),
      handler: "handler",
      memorySize: 512,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30)
    });

    const api = new apigateway.RestApi(this, "AnalysisApi", {
      defaultCorsPreflightOptions: {
        allowHeaders: ["Content-Type"],
        allowMethods: ["GET", "OPTIONS", "POST"],
        allowOrigins: apigateway.Cors.ALL_ORIGINS
      },
      deployOptions: {
        stageName: "prod"
      }
    });

    const healthResource = api.root.addResource("health");
    healthResource.addMethod(
      "GET",
      new apigateway.MockIntegration({
        integrationResponses: [
          {
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": "'*'"
            },
            responseTemplates: {
              "application/json": JSON.stringify({
                status: "ok"
              })
            },
            statusCode: "200"
          }
        ],
        requestTemplates: {
          "application/json": JSON.stringify({
            statusCode: 200
          })
        }
      }),
      {
        methodResponses: [
          {
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": true
            },
            statusCode: "200"
          }
        ]
      }
    );

    const analyzeResource = api.root.addResource("analyze");
    analyzeResource.addMethod("POST", new apigateway.LambdaIntegration(analysisFunction));

    cdk.Tags.of(this).add("Project", "InfraLens");

    new cdk.CfnOutput(this, "FrontendBucketName", {
      value: frontendBucket.bucketName
    });
    new cdk.CfnOutput(this, "FrontendDistributionDomainName", {
      value: frontendDistribution.distributionDomainName
    });
    new cdk.CfnOutput(this, "FrontendDistributionId", {
      value: frontendDistribution.distributionId
    });
    new cdk.CfnOutput(this, "AnalysisApiUrl", {
      value: `${api.url}analyze`
    });
    new cdk.CfnOutput(this, "AnalysisApiBaseUrl", {
      value: api.url
    });
  }
}
