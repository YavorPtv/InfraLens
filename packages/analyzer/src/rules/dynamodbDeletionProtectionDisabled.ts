import type { AnalysisContext, Finding, Rule } from "@infralens/shared";

const RULE_ID = "DYNAMODB_DELETION_PROTECTION_DISABLED";

export const dynamodbDeletionProtectionDisabledRule: Rule = {
  id: RULE_ID,
  title: "DynamoDB table deletion protection is disabled",
  severity: "medium",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) =>
      resource.Type === "AWS::DynamoDB::Table" &&
      resource.Properties?.DeletionProtectionEnabled !== true
        ? [{
            ruleId: RULE_ID,
            title: "DynamoDB table deletion protection is disabled",
            severity: "medium" as const,
            resourceId,
            explanation:
              "Deletion protection is disabled, so an authorized user or process can delete this table accidentally.",
            evidencePath: `Resources.${resourceId}.Properties.DeletionProtectionEnabled`,
            suggestion: "Set DeletionProtectionEnabled to true for tables that retain important data."
          }]
        : []
    );
  }
};
