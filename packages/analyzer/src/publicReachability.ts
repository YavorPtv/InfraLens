import type { ArchitectureEdge } from "@infralens/shared";

export function findPubliclyReachableResources(
  publicEntryPointIds: string[],
  edges: ArchitectureEdge[]
): Set<string> {
  const reachableResourceIds = new Set(publicEntryPointIds);
  const queue = [...publicEntryPointIds];
  const outgoingEdges = groupEdgesBySource(edges);

  while (queue.length > 0) {
    const resourceId = queue.shift();
    if (resourceId === undefined) {
      continue;
    }

    for (const edge of outgoingEdges.get(resourceId) ?? []) {
      if (reachableResourceIds.has(edge.to)) {
        continue;
      }

      reachableResourceIds.add(edge.to);
      queue.push(edge.to);
    }
  }

  return reachableResourceIds;
}

function groupEdgesBySource(edges: ArchitectureEdge[]): Map<string, ArchitectureEdge[]> {
  const groupedEdges = new Map<string, ArchitectureEdge[]>();

  for (const edge of edges) {
    groupedEdges.set(edge.from, [...(groupedEdges.get(edge.from) ?? []), edge]);
  }

  return groupedEdges;
}
