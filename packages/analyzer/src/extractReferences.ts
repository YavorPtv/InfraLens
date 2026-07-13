import type { ArchitectureEdge, ArchitectureRelationship, CfnTemplate } from "@infralens/shared";

type ReferenceRelationship = Extract<ArchitectureRelationship, "references" | "depends-on">;

export interface CloudFormationReference {
  from: string;
  to: string;
  relationship: ReferenceRelationship;
  evidencePath: string;
}

export function extractCloudFormationReferences(template: CfnTemplate): CloudFormationReference[] {
  return Object.entries(template.Resources).flatMap(([resourceId, resource]) => [
    ...extractDependsOnReferences(resourceId, resource.DependsOn),
    ...extractValueReferences(resource, resourceId, `Resources.${resourceId}`)
  ]);
}

export function referencesToArchitectureEdges(
  references: CloudFormationReference[]
): ArchitectureEdge[] {
  return references.map((reference) => ({
    from: reference.from,
    to: reference.to,
    relationship: reference.relationship,
    evidencePath: reference.evidencePath
  }));
}

function extractDependsOnReferences(
  from: string,
  dependsOn: string | string[] | undefined
): CloudFormationReference[] {
  if (typeof dependsOn === "string") {
    return [
      {
        from,
        to: dependsOn,
        relationship: "depends-on",
        evidencePath: `Resources.${from}.DependsOn`
      }
    ];
  }

  if (Array.isArray(dependsOn)) {
    return dependsOn.flatMap((to, index) =>
      typeof to === "string"
        ? [
            {
              from,
              to,
              relationship: "depends-on",
              evidencePath: `Resources.${from}.DependsOn[${index}]`
            }
          ]
        : []
    );
  }

  return [];
}

function extractValueReferences(
  value: unknown,
  from: string,
  path: string
): CloudFormationReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => extractValueReferences(item, from, `${path}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const references = extractIntrinsicReferences(value, from, path);
  const childReferences = Object.entries(value).flatMap(([key, childValue]) =>
    extractValueReferences(childValue, from, appendPath(path, key))
  );

  return [...references, ...childReferences];
}

function extractIntrinsicReferences(
  value: Record<string, unknown>,
  from: string,
  path: string
): CloudFormationReference[] {
  const references: CloudFormationReference[] = [];

  if (typeof value.Ref === "string") {
    references.push({
      from,
      to: value.Ref,
      relationship: "references",
      evidencePath: `${path}.Ref`
    });
  }

  const getAtt = value["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
    references.push({
      from,
      to: getAtt[0],
      relationship: "references",
      evidencePath: `${path}.Fn::GetAtt[0]`
    });
  }

  return references;
}

function appendPath(path: string, key: string): string {
  return `${path}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
