import type { ArchitectureEdge, ArchitectureRelationship, CfnTemplate } from "@infralens/shared";
import { extractResourceReferences } from "./resourceReferences";

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
    ...extractResourceReferences(resource, `Resources.${resourceId}`).map((reference) => ({
      from: resourceId,
      to: reference.resourceId,
      relationship: "references" as const,
      evidencePath: reference.evidencePath
    }))
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
