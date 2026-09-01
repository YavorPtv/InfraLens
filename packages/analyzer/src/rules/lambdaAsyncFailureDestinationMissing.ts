import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";

const RULE_ID = "LAMBDA_DEAD_LETTER_CONFIG_MISSING";

export const lambdaAsyncFailureDestinationMissingRule: Rule = {
  id: RULE_ID,
  title: "Lambda asynchronous invocation has no failure destination",
  severity: "medium",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::Lambda::EventInvokeConfig") {
        return [];
      }

      const destinationConfig = resource.Properties?.DestinationConfig;
      const onFailure = isRecord(destinationConfig) ? destinationConfig.OnFailure : undefined;
      if (isRecord(onFailure) && onFailure.Destination !== undefined) {
        return [];
      }

      return [{
        ruleId: RULE_ID,
        title: "Lambda asynchronous invocation has no failure destination",
        severity: "medium",
        resourceId,
        explanation:
          "This EventInvokeConfig proves the function uses asynchronous invocation settings, but failed events have no configured destination and can be discarded after retries are exhausted.",
        evidencePath: `Resources.${resourceId}.Properties.DestinationConfig.OnFailure.Destination`,
        suggestion:
          "Configure DestinationConfig.OnFailure with an appropriate SQS queue, SNS topic, S3 bucket, Lambda function, or EventBridge event bus."
      }];
    });
  }
};

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
