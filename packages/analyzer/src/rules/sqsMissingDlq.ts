import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";

import { directResourceId } from "../iamPolicyModel";

const RULE_ID = "SQS_MISSING_DLQ";

export const sqsMissingDlqRule: Rule = {
  id: RULE_ID,
  title: "SQS queue is missing a dead-letter queue",
  severity: "medium",
  evaluate(context: AnalysisContext): Finding[] {
    const deadLetterQueueResourceIds = findDeadLetterQueueResourceIds(context);

    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::SQS::Queue") {
        return [];
      }

      if (deadLetterQueueResourceIds.has(resourceId)) {
        return [];
      }

      if (resource.Properties?.RedrivePolicy !== undefined) {
        return [];
      }

      return [
        {
          ruleId: RULE_ID,
          title: "SQS queue is missing a dead-letter queue",
          severity: "medium",
          resourceId,
          explanation:
            "This SQS queue does not define a RedrivePolicy, so failed messages may be retried until they expire without being isolated for inspection.",
          evidencePath: `Resources.${resourceId}.Properties.RedrivePolicy`,
          suggestion:
            "Configure RedrivePolicy with a deadLetterTargetArn and maxReceiveCount that match the workload failure-handling requirements."
        }
      ];
    });
  }
};

function findDeadLetterQueueResourceIds(context: AnalysisContext): Set<string> {
  const resourceIds = new Set<string>();

  for (const resource of Object.values(context.template.Resources)) {
    const properties = resource.Properties;
    const targets: Array<CfnValue | undefined> = [];
    if (resource.Type === "AWS::SQS::Queue" && isRecord(properties?.RedrivePolicy)) targets.push(properties.RedrivePolicy.deadLetterTargetArn);
    if (resource.Type === "AWS::Lambda::Function" && isRecord(properties?.DeadLetterConfig)) targets.push(properties.DeadLetterConfig.TargetArn);
    if (["AWS::Lambda::EventInvokeConfig", "AWS::Lambda::EventSourceMapping"].includes(resource.Type) && isRecord(properties?.DestinationConfig)) {
      const failure = properties.DestinationConfig.OnFailure;
      if (isRecord(failure)) targets.push(failure.Destination);
    }
    if (resource.Type === "AWS::Events::Rule" && Array.isArray(properties?.Targets)) {
      for (const target of properties.Targets) if (isRecord(target) && isRecord(target.DeadLetterConfig)) targets.push(target.DeadLetterConfig.Arn);
    }
    if (resource.Type === "AWS::SNS::Subscription" && isRecord(properties?.RedrivePolicy)) targets.push(properties.RedrivePolicy.deadLetterTargetArn);
    for (const target of targets) {
      const id = directResourceId(target);
      if (id && context.template.Resources[id]?.Type === "AWS::SQS::Queue") resourceIds.add(id);
    }
  }
  return resourceIds;
}

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
