import { buildIamAnalysis, describeIamContext, iamStatementContext } from "../iamPolicyModel";
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
    const model = buildIamAnalysis(context.template);
    return findIamPolicyStatements(context.template, model).flatMap(({ resourceId, statement, evidencePath }) => {
      const hasPassRole = getIamActionStrings(statement.Action).some(
        (action) => action.toLowerCase() === "iam:passrole"
      );
      if (statement.Effect !== "Allow" || !hasPassRole || !hasWildcardResource(statement.Resource)) {
        return [];
      }

      return [{
        iamContext: iamStatementContext(context.template, evidencePath, statement, model),
        ruleId: RULE_ID,
        title: "IAM PassRole permission applies to every role",
        severity: "high",
        resourceId,
        explanation:
          "Allowing iam:PassRole on Resource \"*\" can let a principal pass highly privileged roles to AWS services and create privilege-escalation paths." + " " + describeIamContext(iamStatementContext(context.template, evidencePath, statement, model)),
        evidencePath,
        suggestion:
          "Restrict iam:PassRole to the specific role ARNs required and add iam:PassedToService conditions where practical."
      }];
    });
  }
};
