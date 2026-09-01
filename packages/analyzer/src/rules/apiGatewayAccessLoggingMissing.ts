import type { AnalysisContext, CfnValue, Finding, Rule } from "@infralens/shared";

const RULE_ID = "API_GATEWAY_ACCESS_LOGGING_MISSING";

export const apiGatewayAccessLoggingMissingRule: Rule = {
  id: RULE_ID,
  title: "API Gateway stage access logging is not configured",
  severity: "medium",
  evaluate(context: AnalysisContext): Finding[] {
    return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
      if (resource.Type !== "AWS::ApiGateway::Stage") {
        return [];
      }

      const setting = resource.Properties?.AccessLogSetting;
      if (isRecord(setting) && setting.DestinationArn !== undefined && setting.Format !== undefined) {
        return [];
      }

      return [{
        ruleId: RULE_ID,
        title: "API Gateway stage access logging is not configured",
        severity: "medium",
        resourceId,
        explanation:
          "This REST API stage lacks a complete access log destination and format, limiting request auditing and incident investigation.",
        evidencePath: `Resources.${resourceId}.Properties.AccessLogSetting`,
        suggestion:
          "Configure AccessLogSetting.DestinationArn and a Format that includes $context.requestId."
      }];
    });
  }
};

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
