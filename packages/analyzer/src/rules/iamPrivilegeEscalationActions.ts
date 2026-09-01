import type { AnalysisContext, Finding, Rule } from "@infralens/shared";
import {
  findIamPolicyStatements,
  getIamActionStrings,
  hasWildcardResource
} from "../iamPolicyStatements";

const RULE_ID = "IAM_PRIVILEGE_ESCALATION_ACTIONS";
const permissionMutationActions = new Set([
  "iam:createpolicyversion",
  "iam:setdefaultpolicyversion",
  "iam:attachrolepolicy",
  "iam:putrolepolicy",
  "iam:updateassumerolepolicy"
]);

export const iamPrivilegeEscalationActionsRule: Rule = {
  id: RULE_ID,
  title: "IAM permission-mutation actions apply to wildcard resources",
  severity: "high",
  evaluate(context: AnalysisContext): Finding[] {
    return findIamPolicyStatements(context.template).flatMap(({ resourceId, statement, evidencePath }) => {
      const dangerousActions = getIamActionStrings(statement.Action).filter((action) =>
        permissionMutationActions.has(action.toLowerCase())
      );
      if (
        statement.Effect !== "Allow" ||
        dangerousActions.length === 0 ||
        !hasWildcardResource(statement.Resource)
      ) {
        return [];
      }

      return [{
        ruleId: RULE_ID,
        title: "IAM permission-mutation actions apply to wildcard resources",
        severity: "high",
        resourceId,
        explanation: `This statement allows permission-changing IAM actions on wildcard resources: ${dangerousActions.join(", ")}. These concrete permissions can modify roles or managed policies and may enable privilege escalation.`,
        evidencePath,
        suggestion:
          "Remove unneeded permission-management actions and restrict required actions to specific role or policy ARNs."
      }];
    });
  }
};
