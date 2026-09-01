import type { AnalysisContext, Finding, Rule } from "@infralens/shared";

const RULE_ID = "API_GATEWAY_TRACING_DISABLED";

export const apiGatewayTracingDisabledRule: Rule = {
  id: RULE_ID,
  title: "API Gateway stage active tracing is disabled",
  severity: "low",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) =>
      resource.Type === "AWS::ApiGateway::Stage" && resource.Properties?.TracingEnabled !== true
        ? [{
            ruleId: RULE_ID,
            title: "API Gateway stage active tracing is disabled",
            severity: "low" as const,
            resourceId,
            explanation:
              "This REST API stage does not enable active X-Ray tracing, reducing end-to-end request visibility.",
            evidencePath: `Resources.${resourceId}.Properties.TracingEnabled`,
            suggestion: "Set TracingEnabled to true when X-Ray observability is appropriate."
          }]
        : []
    );
  }
};
