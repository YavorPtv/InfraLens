import type { AnalysisContext, Finding, Rule } from "@infralens/shared";
import {
  findIamPolicyStatements,
  getIamActionStrings,
  hasWildcardResource
} from "../iamPolicyStatements";

const RULE_ID = "IAM_PASSROLE_WILDCARD";

export const iamPassRoleWildcardRule: Rule = {
  id: RULE_ID,
  title: "IAM PassRole permission applies to every role",
  severity: "high",
  evaluate(context: AnalysisContext): Finding[] {
    return findIamPolicyStatements(context.template).flatMap(({ resourceId, statement, evidencePath }) => {
      const hasPassRole = getIamActionStrings(statement.Action).some(
        (action) => action.toLowerCase() === "iam:passrole"
      );
      if (statement.Effect !== "Allow" || !hasPassRole || !hasWildcardResource(statement.Resource)) {
        return [];
      }

      return [{
        ruleId: RULE_ID,
        title: "IAM PassRole permission applies to every role",
        severity: "high",
        resourceId,
        explanation:
          "Allowing iam:PassRole on Resource \"*\" can let a principal pass highly privileged roles to AWS services and create privilege-escalation paths.",
        evidencePath,
        suggestion:
          "Restrict iam:PassRole to the specific role ARNs required and add iam:PassedToService conditions where practical."
      }];
    });
  }
};
