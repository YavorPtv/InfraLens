import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";

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
    if (resource.Type !== "AWS::SQS::Queue") {
      continue;
    }

    const redrivePolicy = resource.Properties?.RedrivePolicy;
    if (!isRecord(redrivePolicy)) {
      continue;
    }

    const targetResourceId = getDeadLetterTargetResourceId(redrivePolicy.deadLetterTargetArn);
    if (targetResourceId !== undefined) {
      resourceIds.add(targetResourceId);
    }
  }

  return resourceIds;
}

function getDeadLetterTargetResourceId(targetArn: CfnValue | undefined): string | undefined {
  if (!isRecord(targetArn)) {
    return undefined;
  }

  const getAtt = targetArn["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
    return getAtt[0];
  }

  if (typeof getAtt === "string") {
    return getAtt.split(".")[0];
  }

  return undefined;
}

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
