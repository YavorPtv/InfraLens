#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import {
  InfraLensStack,
  type InfraLensEnvironment,
  type InfraLensRequestLimitConfiguration
} from "./infralens-stack";

const app = new cdk.App();
const environmentName = readEnvironment(app.node.tryGetContext("environment"));

new InfraLensStack(app, "InfraLensStack", {
  environmentName,
  cognitoDomainPrefix: app.node.tryGetContext("cognitoDomainPrefix"),
  frontendOrigin: app.node.tryGetContext("frontendOrigin"),
  alertEmail: app.node.tryGetContext("alertEmail"),
  monthlyBudgetUsd: readOptionalNumber(app.node.tryGetContext("monthlyBudgetUsd")),
  apiThrottleRateLimit: readOptionalNumber(app.node.tryGetContext("apiThrottleRateLimit")),
  apiThrottleBurstLimit: readOptionalNumber(app.node.tryGetContext("apiThrottleBurstLimit")),
  lambdaReservedConcurrency: readOptionalNumber(
    app.node.tryGetContext("lambdaReservedConcurrency")
  ),
  requestLimits: readRequestLimits(app),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});

function readEnvironment(value: unknown): InfraLensEnvironment {
  const environment = value ?? "development";
  if (environment !== "development" && environment !== "production") {
    throw new Error("CDK context environment must be development or production.");
  }

  return environment;
}

function readRequestLimits(app: cdk.App): InfraLensRequestLimitConfiguration {
  return {
    maxRequestBytes: readOptionalNumber(app.node.tryGetContext("maxRequestBytes")),
    maxTemplateBytes: readOptionalNumber(app.node.tryGetContext("maxTemplateBytes")),
    maxSourceFiles: readOptionalNumber(app.node.tryGetContext("maxSourceFiles")),
    maxSourceFileBytes: readOptionalNumber(app.node.tryGetContext("maxSourceFileBytes")),
    maxCombinedSourceBytes: readOptionalNumber(
      app.node.tryGetContext("maxCombinedSourceBytes")
    ),
    maxSourceMappings: readOptionalNumber(app.node.tryGetContext("maxSourceMappings")),
    maxSourceExclusions: readOptionalNumber(app.node.tryGetContext("maxSourceExclusions")),
    maxDiffTemplateBytes: readOptionalNumber(app.node.tryGetContext("maxDiffTemplateBytes")),
    maxFixes: readOptionalNumber(app.node.tryGetContext("maxFixes"))
  };
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric CDK context value, received ${String(value)}.`);
  }

  return parsed;
}
