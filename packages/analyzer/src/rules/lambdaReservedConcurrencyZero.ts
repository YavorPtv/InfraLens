import type { AnalysisContext, Finding, Rule } from "@infralens/shared";

const RULE_ID = "LAMBDA_RESERVED_CONCURRENCY_RISK";

export const lambdaReservedConcurrencyZeroRule: Rule = {
  id: RULE_ID,
  title: "Lambda reserved concurrency blocks all invocations",
  severity: "medium",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) =>
      resource.Type === "AWS::Lambda::Function" &&
      resource.Properties?.ReservedConcurrentExecutions === 0
        ? [{
            ruleId: RULE_ID,
            title: "Lambda reserved concurrency blocks all invocations",
            severity: "medium" as const,
            resourceId,
            explanation:
              "ReservedConcurrentExecutions is set to zero, so Lambda intentionally throttles every invocation of this function.",
            evidencePath: `Resources.${resourceId}.Properties.ReservedConcurrentExecutions`,
            suggestion:
              "Confirm that the function is intentionally disabled; otherwise set a positive reserved concurrency or remove the property."
          }]
        : []
    );
  }
};
