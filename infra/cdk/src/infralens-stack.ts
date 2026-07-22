import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
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
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      defaultRootObject: "index.html"
    });

    const analysisFunction = new lambda.Function(this, "AnalysisApiFunction", {
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromInline(getAnalysisHandlerSource()),
      handler: "index.handler",
      memorySize: 512,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30)
    });

    const api = new apigateway.RestApi(this, "AnalysisApi", {
      defaultCorsPreflightOptions: {
        allowHeaders: ["Content-Type"],
        allowMethods: ["OPTIONS", "POST"],
        allowOrigins: apigateway.Cors.ALL_ORIGINS
      },
      deployOptions: {
        stageName: "prod"
      }
    });

    const analyzeResource = api.root.addResource("analyze");
    analyzeResource.addMethod("POST", new apigateway.LambdaIntegration(analysisFunction));

    cdk.Tags.of(this).add("Project", "InfraLens");

    new cdk.CfnOutput(this, "FrontendBucketName", {
      value: frontendBucket.bucketName
    });
    new cdk.CfnOutput(this, "FrontendDistributionDomainName", {
      value: frontendDistribution.distributionDomainName
    });
    new cdk.CfnOutput(this, "AnalysisApiUrl", {
      value: `${api.url}analyze`
    });
  }
}

function getAnalysisHandlerSource(): string {
  return `
exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  return {
    statusCode: 501,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      error: "Analysis Lambda skeleton is deployed, but analyzer packaging is not wired yet."
    })
  };
};
`;
}
