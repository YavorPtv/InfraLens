import type { CfnResource, CfnTemplate } from "@infralens/shared";

const alwaysPublicEntryPointTypes = new Set([
  "AWS::ApiGateway::RestApi",
  "AWS::ApiGatewayV2::Api",
  "AWS::CloudFront::Distribution"
]);

export function detectPublicEntryPoints(template: CfnTemplate): string[] {
  return Object.entries(template.Resources)
    .filter(([, resource]) => isPublicEntryPoint(resource))
    .map(([resourceId]) => resourceId);
}

function isPublicEntryPoint(resource: CfnResource): boolean {
  if (alwaysPublicEntryPointTypes.has(resource.Type)) {
    return true;
  }

  return (
    resource.Type === "AWS::ElasticLoadBalancingV2::LoadBalancer" &&
    resource.Properties?.Scheme === "internet-facing"
  );
}
