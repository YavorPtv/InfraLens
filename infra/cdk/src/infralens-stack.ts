import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { join } from "node:path";
import type { Construct } from "constructs";
import {
  frontendUrls,
  validateDeploymentTarget,
  type DeploymentTarget,
  type DeploymentTargetName
} from "./deployment-target";

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

export interface InfraLensStackProps extends Omit<cdk.StackProps, "env" | "stackName"> {
  target: DeploymentTarget;
  historyQuotas?: {
    projectsPerUser?: number;
    runsPerProject?: number;
    runsPerUser?: number;
    retainedInputBytes?: number;
    saveKeysPerUser?: number;
  };
  alertEmail?: string;
  monthlyBudgetUsd?: number;
  apiThrottleRateLimit?: number;
  apiThrottleBurstLimit?: number;
  lambdaReservedConcurrency?: number;
  requestLimits?: InfraLensRequestLimitConfiguration;
}

interface ProtectedRouteOptions {
  authorizer: apigateway.IAuthorizer;
  authorizationScopes?: string[];
}

export class InfraLensStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraLensStackProps) {
    validateDeploymentTarget(props.target);
    super(scope, id, {
      ...props,
      env: { account: props.target.account, region: props.target.region },
      stackName: props.target.stackName
    });

    const target = props.target;
    const environmentName = target.name;
    validateConfiguration(props);

    if (target.applicationPermissionsBoundaryArn) {
      // An administrator owns this policy outside the application stack.
      const boundary = iam.ManagedPolicy.fromManagedPolicyArn(
        this, "ApplicationPermissionsBoundary", target.applicationPermissionsBoundaryArn
      );
      iam.PermissionsBoundary.of(this).apply(boundary);
    }

    // Test is a persistent environment too. Teardown is a separate operator decision.
    const persistenceRemovalPolicy = cdk.RemovalPolicy.RETAIN;
    const projectsTable = new dynamodb.Table(this, "ProjectsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: target.pointInTimeRecovery },
      removalPolicy: persistenceRemovalPolicy
    });
    const runsTable = new dynamodb.Table(this, "RunsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: target.pointInTimeRecovery },
      timeToLiveAttribute: "expiresAt",
      removalPolicy: persistenceRemovalPolicy
    });
    const artifactBucket = new s3.Bucket(this, "ArtifactBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: persistenceRemovalPolicy,
      lifecycleRules: [
        {
          id: "ExpireRetainedInputs",
          tagFilters: { retention: "input" },
          expiration: cdk.Duration.days(7)
        },
        { id: "AbortIncompleteUploads", abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }
      ]
    });

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
    const frontendOrigins = [cloudFrontOrigin, ...target.additionalFrontendOrigins];

    const lambdaLogGroup = new logs.LogGroup(this, "AnalysisFunctionLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN
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
    analysisFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:ValidateTemplate"],
        resources: ["*"]
      })
    );
    // Transactional Put operations authorize against PutItem; no Scan or wildcard grants.
    analysisFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"],
        resources: [projectsTable.tableArn, runsTable.tableArn]
      })
    );
    analysisFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:PutObjectTagging", "s3:DeleteObject"],
        resources: [artifactBucket.arnForObjects("owners/*")]
      })
    );

    const analysisFunction = new nodejs.NodejsFunction(this, "AnalysisApiFunction", {
      architecture: lambda.Architecture.ARM_64,
      bundling: {
        minify: false,
        bundleAwsSDK: true,
        sourceMap: true,
        target: "node22"
      },
      depsLockFilePath: join(__dirname, "../../../package-lock.json"),
      entry: join(__dirname, "../../../apps/api/src/lambda.ts"),
      environment: {
        INFRALENS_CORS_ORIGINS: frontendOrigins.join(","),
        INFRALENS_ENVIRONMENT: target.runtimeEnvironment,
        INFRALENS_CLOUDFORMATION_VALIDATION: "true",
        INFRALENS_HISTORY_ADAPTER: "aws",
        INFRALENS_PROJECTS_TABLE: projectsTable.tableName,
        INFRALENS_RUNS_TABLE: runsTable.tableName,
        INFRALENS_ARTIFACT_BUCKET: artifactBucket.bucketName,
        ...toHistoryQuotaEnvironment(props.historyQuotas),
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
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30)
    });

    const accessLogGroup = new logs.LogGroup(this, "AnalysisApiAccessLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const api = new apigateway.RestApi(this, "AnalysisApi", {
      cloudWatchRole: true,
      defaultCorsPreflightOptions: {
        allowHeaders: ["Authorization", "Content-Type"],
        allowMethods: ["GET", "OPTIONS", "POST", "PATCH", "DELETE"],
        allowOrigins: frontendOrigins
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
              "method.response.header.Access-Control-Allow-Origin": quoteForGateway(cloudFrontOrigin),
              "method.response.header.Vary": "'Origin'"
            },
            responseTemplates: {
              "application/json": `${additionalOriginResponseTemplate(target.additionalFrontendOrigins)}\n${JSON.stringify({ status: "ok" })}`
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
              "method.response.header.Access-Control-Allow-Origin": true,
              "method.response.header.Vary": true
            },
            statusCode: "200"
          }
        ]
      }
    );

    const routeOptions = createHostedAuthentication(this, frontendOrigins, target.cognitoDomainPrefix);

    addAnalysisApiRoutes(api, analysisFunction, routeOptions);
    addAuthenticationGatewayResponses(api, cloudFrontOrigin);
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
    new cdk.CfnOutput(this, "DeploymentAccount", { value: target.account });
    new cdk.CfnOutput(this, "DeploymentRegion", { value: target.region });
    new cdk.CfnOutput(this, "DeploymentStackName", { value: target.stackName });
    new cdk.CfnOutput(this, "FrontendOrigin", { value: cloudFrontOrigin });
    new cdk.CfnOutput(this, "AllowedFrontendOrigins", { value: frontendOrigins.join(",") });
    new cdk.CfnOutput(this, "ProjectsTableName", { value: projectsTable.tableName });
    new cdk.CfnOutput(this, "RunsTableName", { value: runsTable.tableName });
    new cdk.CfnOutput(this, "ArtifactBucketName", { value: artifactBucket.bucketName });
  }
}

export function addAnalysisApiRoutes(
  api: apigateway.RestApi,
  analysisFunction: lambda.IFunction,
  options: ProtectedRouteOptions
): void {
  const methodOptions: apigateway.MethodOptions = {
    authorizationType: apigateway.AuthorizationType.COGNITO,
    authorizer: options.authorizer,
    authorizationScopes: options.authorizationScopes
  };

  for (const path of ["analyze", "diff", "apply"]) {
    api.root
      .addResource(path)
      .addMethod("POST", new apigateway.LambdaIntegration(analysisFunction), methodOptions);
  }
  const projects = api.root.addResource("projects");
  const integration = new apigateway.LambdaIntegration(analysisFunction);
  for (const method of ["GET", "POST"]) {
    projects.addMethod(method, integration, methodOptions);
  }
  projects.addResource("cleanup").addMethod("POST", integration, methodOptions);
  projects.addResource("compare").addMethod("POST", integration, methodOptions);
  const project = projects.addResource("{projectId}");
  for (const method of ["PATCH", "DELETE"]) {
    project.addMethod(method, integration, methodOptions);
  }
  const runs = project.addResource("runs");
  for (const method of ["GET", "POST"]) {
    runs.addMethod(method, integration, methodOptions);
  }
  const run = runs.addResource("{runId}");
  for (const method of ["GET", "DELETE"]) {
    run.addMethod(method, integration, methodOptions);
  }
  run
    .addResource("artifacts")
    .addResource("{artifact}")
    .addMethod("GET", integration, methodOptions);
}

function createHostedAuthentication(
  scope: Construct,
  frontendOrigins: string[],
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
      callbackUrls: frontendUrls(frontendOrigins).callbackUrls,
      flows: { authorizationCodeGrant: true },
      logoutUrls: frontendUrls(frontendOrigins).logoutUrls,
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
  new cdk.CfnOutput(scope, "CognitoCallbackUrls", { value: frontendUrls(frontendOrigins).callbackUrls.join(",") });
  new cdk.CfnOutput(scope, "CognitoLogoutUrls", { value: frontendUrls(frontendOrigins).logoutUrls.join(",") });

  return {
    authorizer,
    authorizationScopes: ["openid"]
  };
}

function addAuthenticationGatewayResponses(api: apigateway.RestApi, frontendOrigin: string): void {
  // GatewayResponse headers cannot conditionally select an allowed origin. Use the hosted
  // origin; localhost still has exact CORS on preflight and all Lambda responses.
  const responseParameters = {
    "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
    "Access-Control-Allow-Origin": quoteForGateway(frontendOrigin),
    Vary: "'Origin'"
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
  environmentName: DeploymentTargetName,
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
      .filter(
        (entry): entry is [keyof InfraLensRequestLimitConfiguration, number] =>
          entry[1] !== undefined
      )
      .map(([key, value]) => [environmentKeys[key], String(value)])
  );
}

function toHistoryQuotaEnvironment(
  quotas: InfraLensStackProps["historyQuotas"]
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [quotaName, value] of Object.entries(quotas ?? {})) {
    const uppercaseName = quotaName.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
    environment[`INFRALENS_QUOTA_${uppercaseName}`] = String(value);
  }

  return environment;
}

function quoteForGateway(value: string): string {
  return `'${value}'`;
}

function additionalOriginResponseTemplate(origins: readonly string[]): string {
  if (origins.length === 0) {
    return "";
  }
  return [
    '#set($origin = $input.params().header.get("Origin"))',
    '#if($origin == "")',
    '  #set($origin = $input.params().header.get("origin"))',
    "#end",
    `#if(${origins.map((origin) => `$origin == "${origin}"`).join(" || ")})`,
    "  #set($context.responseOverride.header.Access-Control-Allow-Origin = $origin)",
    "#end"
  ].join("\n");
}

function validateConfiguration(props: InfraLensStackProps): void {
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

  for (const [key, value] of Object.entries(props.historyQuotas ?? {})) {
    const maximum = key === "retainedInputBytes" ? 4 * 1024 * 1024 : 100000;
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
      throw new Error(`Invalid history quota ${key}`);
    }
  }

  if (props.monthlyBudgetUsd !== undefined && props.alertEmail === undefined) {
    throw new Error("alertEmail is required when monthlyBudgetUsd is configured.");
  }
}
