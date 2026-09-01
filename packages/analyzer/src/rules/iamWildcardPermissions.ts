import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";
import { findIamPolicyStatements } from "../iamPolicyStatements";

const RULE_ID = "IAM_WILDCARD_PERMISSIONS";

export const iamWildcardPermissionsRule: Rule = {
  id: RULE_ID,
  title: "IAM policy allows wildcard actions on wildcard resources",
  severity: "high",
  evaluate(context: AnalysisContext): Finding[] {
    return findIamPolicyStatements(context.template)
      .filter(({ statement }) => isWildcardAllowStatement(statement))
      .map(({ resourceId, evidencePath }) => ({
        ruleId: RULE_ID,
        title: "IAM policy allows wildcard actions on wildcard resources",
        severity: "high",
        resourceId,
        explanation:
          "This IAM policy statement allows wildcard permissions against wildcard resources, which can grant broader access than intended.",
        evidencePath,
        suggestion:
          "Replace wildcard actions and resources with the smallest specific actions and resource ARNs required by the workload."
      }));
  }
};

function isWildcardAllowStatement(statement: Record<string, CfnValue>): boolean {
  return (
    statement.Effect === "Allow" &&
    containsWildcardString(statement.Action) &&
    containsWildcardString(statement.Resource)
  );
}

function containsWildcardString(value: CfnValue | undefined): boolean {
  if (typeof value === "string") {
    return value.includes("*");
  }

  if (Array.isArray(value)) {
    return value.some((item) => typeof item === "string" && item.includes("*"));
  }

  return false;
}
