import type {
  ArchitectureEdge,
  ArchitectureRelationship,
  CfnResource,
  CfnTemplate
} from "@infralens/shared";
import { extractResourceReferences } from "./resourceReferences";

export function buildRuntimeArchitectureGraph(template: CfnTemplate): ArchitectureEdge[] {
  return Object.entries(template.Resources).flatMap(([resourceId, resource]) => [
    ...buildLambdaRoleEdges(template, resourceId, resource),
    ...buildSqsDeadLetterEdges(template, resourceId, resource),
    ...buildApiGatewayInvokeEdges(template, resourceId, resource)
  ]);
}

function buildLambdaRoleEdges(
  template: CfnTemplate,
  resourceId: string,
  resource: CfnResource
): ArchitectureEdge[] {
  if (resource.Type !== "AWS::Lambda::Function") {
    return [];
  }

  return referencesToTypedEdges({
    template,
    from: resourceId,
    value: resource.Properties?.Role,
    path: `Resources.${resourceId}.Properties.Role`,
    targetType: "AWS::IAM::Role",
    relationship: "uses-role"
  });
}

function buildSqsDeadLetterEdges(
  template: CfnTemplate,
  resourceId: string,
  resource: CfnResource
): ArchitectureEdge[] {
  if (resource.Type !== "AWS::SQS::Queue") {
    return [];
  }

  const redrivePolicy = resource.Properties?.RedrivePolicy;
  if (!isRecord(redrivePolicy)) {
    return [];
  }

  return referencesToTypedEdges({
    template,
    from: resourceId,
    value: redrivePolicy.deadLetterTargetArn,
    path: `Resources.${resourceId}.Properties.RedrivePolicy.deadLetterTargetArn`,
    targetType: "AWS::SQS::Queue",
    relationship: "dead-letter"
  });
}

function buildApiGatewayInvokeEdges(
  template: CfnTemplate,
  resourceId: string,
  resource: CfnResource
): ArchitectureEdge[] {
  if (resource.Type !== "AWS::ApiGateway::Method") {
    return [];
  }

  const integration = resource.Properties?.Integration;
  if (!isRecord(integration)) {
    return [];
  }

  return referencesToTypedEdges({
    template,
    from: resourceId,
    value: integration.Uri,
    path: `Resources.${resourceId}.Properties.Integration.Uri`,
    targetType: "AWS::Lambda::Function",
    relationship: "invokes"
  });
}

function referencesToTypedEdges({
  template,
  from,
  value,
  path,
  targetType,
  relationship
}: {
  template: CfnTemplate;
  from: string;
  value: unknown;
  path: string;
  targetType: string;
  relationship: ArchitectureRelationship;
}): ArchitectureEdge[] {
  return extractResourceReferences(value, path)
    .filter((reference) => isResourceType(template, reference.resourceId, targetType))
    .map((reference) => ({
      from,
      to: reference.resourceId,
      relationship,
      evidencePath: reference.evidencePath
    }));
}

function isResourceType(template: CfnTemplate, resourceId: string, type: string): boolean {
  return template.Resources[resourceId]?.Type === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
