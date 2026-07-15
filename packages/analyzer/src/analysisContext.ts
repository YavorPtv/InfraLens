import type { AnalysisContext, ArchitectureEdge, CfnTemplate, ResourceNode } from "@infralens/shared";

export interface AnalysisContextHelpers {
  getResourceById: (id: string) => ResourceNode | undefined;
  getResourcesByType: (type: string) => ResourceNode[];
  getEdgesFrom: (resourceId: string) => ArchitectureEdge[];
  getEdgesTo: (resourceId: string) => ArchitectureEdge[];
  hasResource: (id: string) => boolean;
}

export type AnalyzerAnalysisContext = AnalysisContext & AnalysisContextHelpers;

export interface CreateAnalysisContextInput {
  template: CfnTemplate;
  resources: ResourceNode[];
  edges: ArchitectureEdge[];
  publiclyReachableResourceIds?: string[];
}

export function createAnalysisContext({
  template,
  resources,
  edges,
  publiclyReachableResourceIds = []
}: CreateAnalysisContextInput): AnalyzerAnalysisContext {
  return {
    template,
    resources,
    edges,
    publiclyReachableResourceIds,
    getResourceById(id: string): ResourceNode | undefined {
      return resources.find((resource) => resource.id === id);
    },
    getResourcesByType(type: string): ResourceNode[] {
      return resources.filter((resource) => resource.type === type);
    },
    getEdgesFrom(resourceId: string): ArchitectureEdge[] {
      return edges.filter((edge) => edge.from === resourceId);
    },
    getEdgesTo(resourceId: string): ArchitectureEdge[] {
      return edges.filter((edge) => edge.to === resourceId);
    },
    hasResource(id: string): boolean {
      return resources.some((resource) => resource.id === id);
    }
  };
}
