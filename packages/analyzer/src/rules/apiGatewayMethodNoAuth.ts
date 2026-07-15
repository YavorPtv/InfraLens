import type { AnalysisContext, Finding, Rule } from "@infralens/shared";

const RULE_ID = "API_GATEWAY_METHOD_NO_AUTH";

export const apiGatewayMethodNoAuthRule: Rule = {
  id: RULE_ID,
  title: "API Gateway method does not require authorization",
  severity: "high",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::ApiGateway::Method") {
        return [];
      }

      const authorizationType = resource.Properties?.AuthorizationType;
      if (authorizationType !== undefined && authorizationType !== "NONE") {
        return [];
      }

      return [
        {
          ruleId: RULE_ID,
          title: "API Gateway method does not require authorization",
          severity: "high",
          resourceId,
          explanation:
            "This API Gateway method allows requests without an authorization mechanism, which can expose backend functionality to unauthenticated callers.",
          evidencePath: `Resources.${resourceId}.Properties.AuthorizationType`,
          suggestion:
            "Set AuthorizationType to an appropriate authorizer, IAM, or Cognito authorization mode for this method."
        }
      ];
    });
  }
};
