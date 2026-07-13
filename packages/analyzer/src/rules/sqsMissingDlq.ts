import type { AnalysisContext, Finding, Rule } from "@infralens/shared";

const RULE_ID = "SQS_MISSING_DLQ";

export const sqsMissingDlqRule: Rule = {
  id: RULE_ID,
  title: "SQS queue is missing a dead-letter queue",
  severity: "medium",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::SQS::Queue") {
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
