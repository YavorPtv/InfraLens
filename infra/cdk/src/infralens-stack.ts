import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { join } from "node:path";
import type { Construct } from "constructs";

export type InfraLensEnvironment = "development" | "production";

export interface InfraLensRequestLimitConfiguration {
  maxRequestBytes?: number;
  maxTemplateBytes?: number;
  maxSourceFiles?: number;
  maxSourceFileBytes?: number;
  maxCombinedSourceBytes?: number;
  maxSourceMappings?: number;
  maxSourceExclusions?: number;
  maxDiffTemplateBytes?: number;
  maxFixes?: number;
}

export interface InfraLensStackProps extends cdk.StackProps {
  environmentName?: InfraLensEnvironment;
  frontendOrigin?: string;
  cognitoDomainPrefix?: string;
  alertEmail?: string;
  monthlyBudgetUsd?: number;
  apiThrottleRateLimit?: number;
  apiThrottleBurstLimit?: number;
  lambdaReservedConcurrency?: number;
  requestLimits?: InfraLensRequestLimitConfiguration;
}

interface ProtectedRouteOptions {
  authorizer?: apigateway.IAuthorizer;
  authorizationScopes?: string[];
}

export class InfraLensStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraLensStackProps = {}) {
    super(scope, id, props);

    const environmentName = props.environmentName ?? "development";
    const isProduction = environmentName === "production";
    validateConfiguration(props, isProduction);

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

    const cloudFrontOrigin = `https://${frontendDistribution.distributionDomainName}`;
    const frontendOrigin =
      props.frontendOrigin ?? (isProduction ? cloudFrontOrigin : "http://localhost:5173");

    const lambdaLogGroup = new logs.LogGroup(this, "AnalysisFunctionLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });
    const analysisFunctionRole = new iam.Role(this, "AnalysisFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
    });
    analysisFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [lambdaLogGroup.logGroupArn, `${lambdaLogGroup.logGroupArn}:*`]
      })
    );

    // ValidateTemplate has no resource-level IAM scope; it cannot create or update stacks.
    analysisFunctionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudformation:ValidateTemplate"], resources: ["*"]
    }));

    const analysisFunction = new nodejs.NodejsFunction(this, "AnalysisApiFunction", {
      architecture: lambda.Architecture.ARM_64,
      bundling: {
        minify: false,
        bundleAwsSDK: true,
        sourceMap: true,
        target: "node20"
      },
      depsLockFilePath: join(__dirname, "../../../package-lock.json"),
      entry: join(__dirname, "../../../apps/api/src/lambda.ts"),
      environment: {
        INFRALENS_CORS_ORIGINS: frontendOrigin,
        INFRALENS_ENVIRONMENT: environmentName,
        INFRALENS_CLOUDFORMATION_VALIDATION: "true",
        ...toRequestLimitEnvironment(props.requestLimits)
      },
      handler: "handler",
      logGroup: lambdaLogGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      memorySize: 512,
      ...(props.lambdaReservedConcurrency === undefined
        ? {}
        : { reservedConcurrentExecutions: props.lambdaReservedConcurrency }),
      role: analysisFunctionRole,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30)
    });

    const accessLogGroup = new logs.LogGroup(this, "AnalysisApiAccessLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    const api = new apigateway.RestApi(this, "AnalysisApi", {
      cloudWatchRole: true,
      defaultCorsPreflightOptions: {
        allowHeaders: ["Authorization", "Content-Type"],
        allowMethods: ["GET", "OPTIONS", "POST"],
        allowOrigins: [frontendOrigin]
      },
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: apigateway.AccessLogField.contextRequestId(),
            httpMethod: apigateway.AccessLogField.contextHttpMethod(),
            resourcePath: apigateway.AccessLogField.contextResourcePath(),
            status: apigateway.AccessLogField.contextStatus(),
            responseLatency: apigateway.AccessLogField.contextResponseLatency(),
            integrationLatency: apigateway.AccessLogField.contextIntegrationLatency(),
            integrationStatus: apigateway.AccessLogField.contextIntegrationStatus(),
            integrationError: apigateway.AccessLogField.contextIntegrationErrorMessage()
          })
        ),
        dataTraceEnabled: false,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        stageName: environmentName,
        throttlingBurstLimit: props.apiThrottleBurstLimit ?? 5,
        throttlingRateLimit: props.apiThrottleRateLimit ?? 2
      }
    });

    const healthResource = api.root.addResource("health");
    healthResource.addMethod(
      "GET",
      new apigateway.MockIntegration({
        integrationResponses: [
          {
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": quoteForGateway(frontendOrigin)
            },
            responseTemplates: {
              "application/json": JSON.stringify({ status: "ok" })
            },
            statusCode: "200"
          }
        ],
        requestTemplates: {
          "application/json": JSON.stringify({ statusCode: 200 })
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

    const routeOptions = isProduction
      ? createProductionAuthentication(this, frontendOrigin, props.cognitoDomainPrefix!)
      : {};

    addAnalysisApiRoutes(api, analysisFunction, routeOptions);
    addAuthenticationGatewayResponses(api, frontendOrigin);
    configureOperationalAlarms(this, api, analysisFunction, props.alertEmail);
    configureBudget(this, environmentName, props.monthlyBudgetUsd, props.alertEmail);

    cdk.Tags.of(this).add("Environment", environmentName);
    cdk.Tags.of(this).add("Project", "InfraLens");

    new cdk.CfnOutput(this, "FrontendBucketName", { value: frontendBucket.bucketName });
    new cdk.CfnOutput(this, "FrontendDistributionDomainName", {
      value: frontendDistribution.distributionDomainName
    });
    new cdk.CfnOutput(this, "FrontendDistributionId", {
      value: frontendDistribution.distributionId
    });
    new cdk.CfnOutput(this, "AnalysisApiUrl", { value: `${api.url}analyze` });
    new cdk.CfnOutput(this, "AnalysisDiffApiUrl", { value: `${api.url}diff` });
    new cdk.CfnOutput(this, "AnalysisApplyApiUrl", { value: `${api.url}apply` });
    new cdk.CfnOutput(this, "AnalysisApiBaseUrl", { value: api.url });
    new cdk.CfnOutput(this, "DeploymentEnvironment", { value: environmentName });
  }
}

export function addAnalysisApiRoutes(
  api: apigateway.RestApi,
  analysisFunction: lambda.IFunction,
  options: ProtectedRouteOptions = {}
): void {
  const methodOptions: apigateway.MethodOptions =
    options.authorizer === undefined
      ? {}
      : {
          authorizationType: apigateway.AuthorizationType.COGNITO,
          authorizer: options.authorizer,
          authorizationScopes: options.authorizationScopes
        };

  for (const path of ["analyze", "diff", "apply"]) {
    api.root
      .addResource(path)
      .addMethod("POST", new apigateway.LambdaIntegration(analysisFunction), methodOptions);
  }
}

function createProductionAuthentication(
  scope: Construct,
  frontendOrigin: string,
  domainPrefix: string
): ProtectedRouteOptions {
  const userPool = new cognito.UserPool(scope, "UserPool", {
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    autoVerify: { email: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    selfSignUpEnabled: false,
    signInAliases: { email: true }
  });
  const client = userPool.addClient("WebClient", {
    accessTokenValidity: cdk.Duration.hours(1),
    generateSecret: false,
    oAuth: {
      callbackUrls: [`${frontendOrigin}/auth/callback`],
      flows: { authorizationCodeGrant: true },
      logoutUrls: [`${frontendOrigin}/`],
      scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL]
    },
    preventUserExistenceErrors: true,
    refreshTokenValidity: cdk.Duration.days(7),
    supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO]
  });
  const domain = userPool.addDomain("HostedDomain", {
    cognitoDomain: { domainPrefix }
  });
  const authorizer = new apigateway.CognitoUserPoolsAuthorizer(scope, "ApiAuthorizer", {
    cognitoUserPools: [userPool]
  });

  new cdk.CfnOutput(scope, "CognitoUserPoolId", { value: userPool.userPoolId });
  new cdk.CfnOutput(scope, "CognitoWebClientId", { value: client.userPoolClientId });
  new cdk.CfnOutput(scope, "CognitoHostedDomain", { value: domain.baseUrl() });

  return {
    authorizer,
    authorizationScopes: ["openid"]
  };
}

function addAuthenticationGatewayResponses(api: apigateway.RestApi, frontendOrigin: string): void {
  const responseParameters = {
    "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
    "Access-Control-Allow-Origin": quoteForGateway(frontendOrigin)
  };

  api.addGatewayResponse("UnauthorizedResponse", {
    responseHeaders: responseParameters,
    type: apigateway.ResponseType.UNAUTHORIZED
  });
  api.addGatewayResponse("AccessDeniedResponse", {
    responseHeaders: responseParameters,
    type: apigateway.ResponseType.ACCESS_DENIED
  });
}

function configureOperationalAlarms(
  scope: Construct,
  api: apigateway.RestApi,
  analysisFunction: lambda.IFunction,
  alertEmail?: string
): void {
  const alarmDefaults = {
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 2,
    evaluationPeriods: 2,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
  };
  const alarms = [
    new cloudwatch.Alarm(scope, "AnalysisFunctionErrorsAlarm", {
      ...alarmDefaults,
      metric: analysisFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1
    }),
    new cloudwatch.Alarm(scope, "AnalysisFunctionThrottlesAlarm", {
      ...alarmDefaults,
      metric: analysisFunction.metricThrottles({ period: cdk.Duration.minutes(5) }),
      threshold: 1
    }),
    new cloudwatch.Alarm(scope, "AnalysisFunctionDurationAlarm", {
      ...alarmDefaults,
      metric: analysisFunction.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: "p95"
      }),
      threshold: 24_000
    }),
    new cloudwatch.Alarm(scope, "AnalysisApiServerErrorsAlarm", {
      ...alarmDefaults,
      metric: api.metricServerError({ period: cdk.Duration.minutes(5) }),
      threshold: 1
    })
  ];

  if (alertEmail !== undefined) {
    const topic = new sns.Topic(scope, "OperationalAlertsTopic");
    topic.addSubscription(new subscriptions.EmailSubscription(alertEmail));
    const action = new cloudwatchActions.SnsAction(topic);
    alarms.forEach((alarm) => alarm.addAlarmAction(action));
  }
}

function configureBudget(
  scope: Construct,
  environmentName: InfraLensEnvironment,
  monthlyBudgetUsd?: number,
  alertEmail?: string
): void {
  if (monthlyBudgetUsd === undefined || alertEmail === undefined) {
    return;
  }

  const subscriber = [{ address: alertEmail, subscriptionType: "EMAIL" }];
  new budgets.CfnBudget(scope, "MonthlyCostBudget", {
    budget: {
      budgetLimit: { amount: monthlyBudgetUsd, unit: "USD" },
      budgetName: `InfraLens-${environmentName}-monthly`,
      budgetType: "COST",
      timeUnit: "MONTHLY"
    },
    notificationsWithSubscribers: [
      {
        notification: {
          comparisonOperator: "GREATER_THAN",
          notificationType: "ACTUAL",
          threshold: 80,
          thresholdType: "PERCENTAGE"
        },
        subscribers: subscriber
      },
      {
        notification: {
          comparisonOperator: "GREATER_THAN",
          notificationType: "FORECASTED",
          threshold: 100,
          thresholdType: "PERCENTAGE"
        },
        subscribers: subscriber
      }
    ]
  });
}

function toRequestLimitEnvironment(
  limits: InfraLensRequestLimitConfiguration | undefined
): Record<string, string> {
  if (limits === undefined) {
    return {};
  }

  const environmentKeys: Record<keyof InfraLensRequestLimitConfiguration, string> = {
    maxRequestBytes: "INFRALENS_MAX_REQUEST_BYTES",
    maxTemplateBytes: "INFRALENS_MAX_TEMPLATE_BYTES",
    maxSourceFiles: "INFRALENS_MAX_SOURCE_FILES",
    maxSourceFileBytes: "INFRALENS_MAX_SOURCE_FILE_BYTES",
    maxCombinedSourceBytes: "INFRALENS_MAX_COMBINED_SOURCE_BYTES",
    maxSourceMappings: "INFRALENS_MAX_SOURCE_MAPPINGS",
    maxSourceExclusions: "INFRALENS_MAX_SOURCE_EXCLUSIONS",
    maxDiffTemplateBytes: "INFRALENS_MAX_DIFF_TEMPLATE_BYTES",
    maxFixes: "INFRALENS_MAX_FIXES"
  };

  return Object.fromEntries(
    Object.entries(limits)
      .filter((entry): entry is [keyof InfraLensRequestLimitConfiguration, number] =>
        entry[1] !== undefined
      )
      .map(([key, value]) => [environmentKeys[key], String(value)])
  );
}

function quoteForGateway(value: string): string {
  return `'${value}'`;
}

function validateConfiguration(props: InfraLensStackProps, isProduction: boolean): void {
  if (props.environmentName !== undefined &&
      props.environmentName !== "development" &&
      props.environmentName !== "production") {
    throw new Error("environmentName must be development or production.");
  }

  if (isProduction && !props.cognitoDomainPrefix?.trim()) {
    throw new Error("cognitoDomainPrefix is required for a production deployment.");
  }

  if (props.cognitoDomainPrefix !== undefined) {
    validateCognitoDomainPrefix(props.cognitoDomainPrefix);
  }

  for (const [name, value] of Object.entries({
    apiThrottleBurstLimit: props.apiThrottleBurstLimit,
    apiThrottleRateLimit: props.apiThrottleRateLimit,
    lambdaReservedConcurrency: props.lambdaReservedConcurrency,
    monthlyBudgetUsd: props.monthlyBudgetUsd,
    ...props.requestLimits
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`${name} must be a positive number.`);
    }
  }

  if (props.monthlyBudgetUsd !== undefined && props.alertEmail === undefined) {
    throw new Error("alertEmail is required when monthlyBudgetUsd is configured.");
  }
}

function validateCognitoDomainPrefix(prefix: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix)) {
    throw new Error(
      "cognitoDomainPrefix must be 1-63 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen."
    );
  }

  if (/(?:aws|amazon|cognito)/.test(prefix)) {
    throw new Error("cognitoDomainPrefix must not contain the reserved terms aws, amazon, or cognito.");
  }
}
