import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";

const RULE_ID = "LAMBDA_TRACING_DISABLED";

export const lambdaTracingDisabledRule: Rule = {
  id: RULE_ID,
  title: "Lambda active tracing is disabled",
  severity: "low",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::Lambda::Function") {
        return [];
      }

      const tracing = resource.Properties?.TracingConfig;
      if (isRecord(tracing) && tracing.Mode === "Active") {
        return [];
      }

      return [{
        ruleId: RULE_ID,
        title: "Lambda active tracing is disabled",
        severity: "low",
        resourceId,
        explanation:
          "This function does not use active X-Ray tracing, reducing visibility into invocation latency and downstream calls.",
        evidencePath: `Resources.${resourceId}.Properties.TracingConfig.Mode`,
        suggestion: "Set TracingConfig.Mode to Active when X-Ray observability is appropriate."
      }];
    });
  }
};

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
