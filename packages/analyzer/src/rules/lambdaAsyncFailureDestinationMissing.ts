import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";
import { directResourceId } from "../iamPolicyModel";

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
      // A function DLQ is an alternative to an invocation destination. Only use
      // current function settings for $LATEST; published versions may differ.
      const functionName = resource.Properties?.FunctionName;
      const functions = Object.entries(context.template.Resources).filter(([id, candidate]) =>
        candidate.Type === "AWS::Lambda::Function" && (directResourceId(functionName) === id ||
          (typeof functionName === "string" && candidate.Properties?.FunctionName === functionName)));
      if (resource.Properties?.Qualifier === "$LATEST" && functions.length === 1) {
        const deadLetterConfig = functions[0][1].Properties?.DeadLetterConfig;
        if (isRecord(deadLetterConfig) && deadLetterConfig.TargetArn !== undefined) return [];
      }

      return [{
        ruleId: RULE_ID,
        title: "Lambda asynchronous invocation has no failure destination",
        severity: "medium",
        resourceId,
        explanation:
          "This EventInvokeConfig has no on-failure destination, and InfraLens could not verify an alternative function dead-letter queue for this qualifier. Failed events may be discarded after retries; external functions and published versions require review.",
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
