import type { Rule } from "@infralens/shared";

const sourceServices = new Set(["s3.amazonaws.com", "sns.amazonaws.com", "events.amazonaws.com", "apigateway.amazonaws.com"]);

export const lambdaServicePermissionUnscopedRule: Rule = {
  id: "LAMBDA_SERVICE_PERMISSION_UNSCOPED",
  title: "Lambda service invocation permission has no source restriction",
  severity: "high",
  evaluate: context => Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
    const properties = resource.Properties;
    if (resource.Type !== "AWS::Lambda::Permission" || properties?.Action !== "lambda:InvokeFunction" ||
        typeof properties.Principal !== "string" || !sourceServices.has(properties.Principal) ||
        properties.SourceArn !== undefined || properties.SourceAccount !== undefined || properties.PrincipalOrgID !== undefined ||
        properties.InvokedViaFunctionUrl !== undefined) return [];
    return [{ ruleId: "LAMBDA_SERVICE_PERMISSION_UNSCOPED", title: "Lambda service invocation permission has no source restriction",
      severity: "high" as const, resourceId,
      evidencePath: `Resources.${resourceId}.Properties.Principal`,
      explanation: `This permission allows ${properties.Principal} to invoke the function without a SourceArn or SourceAccount restriction. A resource controlled by another account may be able to invoke it through that service; effective invocation still depends on the service and other policies.`,
      suggestion: "Set SourceArn to the intended API, rule, topic or bucket ARN and SourceAccount where appropriate. Review deliberate cross-account integrations before restricting them." }];
  })
};
