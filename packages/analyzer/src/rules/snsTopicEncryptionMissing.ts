import type { AnalysisContext, Finding, Rule } from "@infralens/shared";

const RULE_ID = "SNS_TOPIC_ENCRYPTION_MISSING";

export const snsTopicEncryptionMissingRule: Rule = {
  id: RULE_ID,
  title: "SNS topic does not use KMS encryption",
  severity: "medium",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) =>
      resource.Type === "AWS::SNS::Topic" && resource.Properties?.KmsMasterKeyId === undefined
        ? [{
            ruleId: RULE_ID,
            title: "SNS topic does not use KMS encryption",
            severity: "medium" as const,
            resourceId,
            explanation:
              "SNS provides disk encryption by default, but this topic does not configure KMS server-side encryption for additional key-based access control.",
            evidencePath: `Resources.${resourceId}.Properties.KmsMasterKeyId`,
            suggestion:
              "Set KmsMasterKeyId to an AWS managed or customer managed KMS key when the topic carries sensitive messages."
          }]
        : []
    );
  }
};
