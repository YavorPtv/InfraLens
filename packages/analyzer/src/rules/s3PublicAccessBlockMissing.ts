import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";

const RULE_ID = "S3_PUBLIC_ACCESS_BLOCK_MISSING";

const requiredPublicAccessBlockProperties = [
  "BlockPublicAcls",
  "BlockPublicPolicy",
  "IgnorePublicAcls",
  "RestrictPublicBuckets"
];

export const s3PublicAccessBlockMissingRule: Rule = {
  id: RULE_ID,
  title: "S3 bucket is missing full public access block",
  severity: "high",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::S3::Bucket") {
        return [];
      }

      const publicAccessBlockConfiguration = resource.Properties?.PublicAccessBlockConfiguration;
      if (hasFullPublicAccessBlock(publicAccessBlockConfiguration)) {
        return [];
      }

      return [
        {
          ruleId: RULE_ID,
          title: "S3 bucket is missing full public access block",
          severity: "high",
          resourceId,
          explanation:
            "This S3 bucket does not explicitly enable every public access block setting, which can allow accidental public exposure through ACLs or bucket policies.",
          evidencePath: `Resources.${resourceId}.Properties.PublicAccessBlockConfiguration`,
          suggestion:
            "Set BlockPublicAcls, BlockPublicPolicy, IgnorePublicAcls, and RestrictPublicBuckets to true."
        }
      ];
    });
  }
};

function hasFullPublicAccessBlock(value: CfnValue | undefined): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return requiredPublicAccessBlockProperties.every((propertyName) => value[propertyName] === true);
}

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
