import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";

const RULE_ID = "S3_VERSIONING_DISABLED";

export const s3VersioningDisabledRule: Rule = {
  id: RULE_ID,
  title: "S3 bucket versioning is not enabled",
  severity: "medium",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::S3::Bucket") {
        return [];
      }

      const versioning = resource.Properties?.VersioningConfiguration;
      if (isRecord(versioning) && versioning.Status === "Enabled") {
        return [];
      }

      return [{
        ruleId: RULE_ID,
        title: "S3 bucket versioning is not enabled",
        severity: "medium",
        resourceId,
        explanation:
          "This bucket does not enable object versioning, reducing recovery options after accidental overwrite or deletion. Some disposable or derived-data buckets may not require versioning.",
        evidencePath: `Resources.${resourceId}.Properties.VersioningConfiguration.Status`,
        suggestion:
          "Enable VersioningConfiguration.Status when the bucket stores data that should be recoverable."
      }];
    });
  }
};

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
