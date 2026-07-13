import type { AnalysisContext, Finding, Rule } from "@infralens/shared";

const RULE_ID = "LOG_GROUP_MISSING_RETENTION";

export const logGroupMissingRetentionRule: Rule = {
  id: RULE_ID,
  title: "CloudWatch log group is missing retention",
  severity: "medium",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::Logs::LogGroup") {
        return [];
      }

      if (resource.Properties?.RetentionInDays !== undefined) {
        return [];
      }

      return [
        {
          ruleId: RULE_ID,
          title: "CloudWatch log group is missing retention",
          severity: "medium",
          resourceId,
          explanation:
            "This CloudWatch log group does not set RetentionInDays, so logs may be retained indefinitely and increase data exposure and storage cost.",
          evidencePath: `Resources.${resourceId}.Properties.RetentionInDays`,
          suggestion:
            "Set RetentionInDays to the shortest retention period that satisfies operational and compliance requirements."
        }
      ];
    });
  }
};
