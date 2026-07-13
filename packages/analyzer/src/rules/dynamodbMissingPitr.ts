import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";

const RULE_ID = "DYNAMODB_MISSING_PITR";

export const dynamodbMissingPitrRule: Rule = {
  id: RULE_ID,
  title: "DynamoDB table is missing point-in-time recovery",
  severity: "high",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::DynamoDB::Table") {
        return [];
      }

      const recoverySpecification = resource.Properties?.PointInTimeRecoverySpecification;
      const recoveryEnabled = isRecord(recoverySpecification)
        ? recoverySpecification.PointInTimeRecoveryEnabled
        : undefined;

      if (recoveryEnabled === true) {
        return [];
      }

      return [
        {
          ruleId: RULE_ID,
          title: "DynamoDB table is missing point-in-time recovery",
          severity: "high",
          resourceId,
          explanation:
            "This DynamoDB table does not have point-in-time recovery enabled, which limits recovery options after accidental writes or deletes.",
          evidencePath: `Resources.${resourceId}.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled`,
          suggestion:
            "Enable PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled so the table can be restored to a recent point in time."
        }
      ];
    });
  }
};

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
