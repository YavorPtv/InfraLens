#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import {
  InfraLensStack,
  type InfraLensStackProps,
  type InfraLensRequestLimitConfiguration
} from "./infralens-stack";
import { resolveDeploymentTarget } from "./deployment-target";

const app = new cdk.App();
for (const legacyKey of ["environment", "frontendOrigin", "cognitoDomainPrefix"]) {
  if (app.node.tryGetContext(legacyKey) !== undefined) {
    throw new Error(`CDK context ${legacyKey} is no longer supported. Configure deployment-target.ts and select -c target=test or -c target=production.`);
  }
}
const target = resolveDeploymentTarget(app.node.tryGetContext("target"));

new InfraLensStack(app, target.stackName, {
  target,
  alertEmail: app.node.tryGetContext("alertEmail"),
  monthlyBudgetUsd: readOptionalNumber(app.node.tryGetContext("monthlyBudgetUsd")),
  apiThrottleRateLimit: readOptionalNumber(app.node.tryGetContext("apiThrottleRateLimit")),
  apiThrottleBurstLimit: readOptionalNumber(app.node.tryGetContext("apiThrottleBurstLimit")),
  lambdaReservedConcurrency: readOptionalNumber(
    app.node.tryGetContext("lambdaReservedConcurrency")
  ),
  requestLimits: readRequestLimits(app),
  historyQuotas: readHistoryQuotas(app)
});

function readRequestLimits(app: cdk.App): InfraLensRequestLimitConfiguration {
  return {
    maxRequestBytes: readOptionalNumber(app.node.tryGetContext("maxRequestBytes")),
    maxTemplateBytes: readOptionalNumber(app.node.tryGetContext("maxTemplateBytes")),
    maxSourceFiles: readOptionalNumber(app.node.tryGetContext("maxSourceFiles")),
    maxSourceFileBytes: readOptionalNumber(app.node.tryGetContext("maxSourceFileBytes")),
    maxCombinedSourceBytes: readOptionalNumber(app.node.tryGetContext("maxCombinedSourceBytes")),
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

function readHistoryQuotas(app: cdk.App): InfraLensStackProps["historyQuotas"] {
  const quotaNames = [
    "projectsPerUser",
    "runsPerProject",
    "runsPerUser",
    "retainedInputBytes",
    "saveKeysPerUser"
  ] as const;
  const quotas: NonNullable<InfraLensStackProps["historyQuotas"]> = {};

  for (const quotaName of quotaNames) {
    const value = readOptionalNumber(app.node.tryGetContext(quotaName));
    if (value !== undefined) {
      quotas[quotaName] = value;
    }
  }

  return quotas;
}
