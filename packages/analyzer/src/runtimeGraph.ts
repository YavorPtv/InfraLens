import type {
  ArchitectureEdge,
  ArchitectureRelationship,
  CfnResource,
  CfnTemplate,
  CfnValue
} from "@infralens/shared";

interface ResourceReference {
  resourceId: string;
  evidencePath: string;
}

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
  value: CfnValue | undefined;
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

function extractResourceReferences(
  value: CfnValue | undefined,
  path: string
): ResourceReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => extractResourceReferences(item, `${path}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const references = extractIntrinsicReferences(value, path);
  const childReferences = Object.entries(value).flatMap(([key, childValue]) =>
    extractResourceReferences(childValue, appendPath(path, key))
  );

  return [...references, ...childReferences];
}

function extractIntrinsicReferences(
  value: Record<string, CfnValue>,
  path: string
): ResourceReference[] {
  const references: ResourceReference[] = [];

  if (typeof value.Ref === "string") {
    references.push({
      resourceId: value.Ref,
      evidencePath: `${path}.Ref`
    });
  }

  const getAtt = value["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
    references.push({
      resourceId: getAtt[0],
      evidencePath: `${path}.Fn::GetAtt[0]`
    });
  }

  if (typeof getAtt === "string") {
    references.push({
      resourceId: getAtt.split(".")[0],
      evidencePath: `${path}.Fn::GetAtt`
    });
  }

  references.push(...extractFnSubReferences(value["Fn::Sub"], `${path}.Fn::Sub`));

  return references;
}

function extractFnSubReferences(value: CfnValue | undefined, path: string): ResourceReference[] {
  if (typeof value === "string") {
    return extractFnSubStringReferences(value, path);
  }

  if (Array.isArray(value)) {
    const [templateString] = value;
    return typeof templateString === "string"
      ? extractFnSubStringReferences(templateString, `${path}[0]`)
      : [];
  }

  return [];
}

function extractFnSubStringReferences(value: string, path: string): ResourceReference[] {
  return Array.from(value.matchAll(/\$\{([^!][^}]+)\}/g)).map((match) => ({
    resourceId: match[1].split(".")[0],
    evidencePath: path
  }));
}

function isResourceType(template: CfnTemplate, resourceId: string, type: string): boolean {
  return template.Resources[resourceId]?.Type === type;
}

function appendPath(path: string, key: string): string {
  return `${path}.${key}`;
}

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
