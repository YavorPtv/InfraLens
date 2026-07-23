import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import type { AnalysisReport, ArchitectureEdge, ResourceNode } from "@infralens/shared";
import "@xyflow/react/dist/style.css";

interface ArchitectureGraphProps {
  report: AnalysisReport;
}

interface ResourceNodeData extends Record<string, unknown> {
  resource: ResourceNode;
  isPublicEntryPoint: boolean;
  isPubliclyReachable: boolean;
}

type ResourceFlowNode = Node<ResourceNodeData, "resource">;

const nodeTypes = {
  resource: ResourceGraphNode
};

const graphNodeWidth = 300;
const graphNodeHeight = 116;
const edgeStrokeColor = "#9aa7b5";

export function ArchitectureGraph({ report }: ArchitectureGraphProps) {
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(
    report.resources[0]?.id ?? null
  );
  const publicEntryPoints = useMemo(
    () => new Set(report.publicEntryPointIds),
    [report.publicEntryPointIds]
  );
  const publiclyReachableResources = useMemo(
    () => new Set(report.publiclyReachableResourceIds),
    [report.publiclyReachableResourceIds]
  );
  const resourceIds = useMemo(
    () => new Set(report.resources.map((resource) => resource.id)),
    [report.resources]
  );
  const visibleEdges = useMemo(
    () => selectVisibleEdges(report.edges, resourceIds),
    [report.edges, resourceIds]
  );
  const initialNodes = useMemo(
    () =>
      createGraphNodes(
        report.resources,
        visibleEdges,
        publicEntryPoints,
        publiclyReachableResources
      ),
    [publicEntryPoints, publiclyReachableResources, report.resources, visibleEdges]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<ResourceFlowNode>(initialNodes);
  const edges = useMemo(() => createGraphEdges(visibleEdges), [visibleEdges]);
  const selectedResource = report.resources.find((resource) => resource.id === selectedResourceId);

  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);

  if (report.resources.length === 0) {
    return (
      <section className="report-panel architecture-panel">
        <div className="section-heading">
          <h2>Architecture Graph</h2>
          <p className="muted-note">No resources were found in this template.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="report-panel architecture-panel">
      <div className="section-heading architecture-heading">
        <div>
          <h2>Architecture Graph</h2>
          <p className="muted-note">
            Resources are shown as nodes. Arrows show typed runtime relationships between
            resources.
          </p>
        </div>
        <div className="graph-legend" aria-label="Graph legend">
          <span>
            <span className="legend-swatch public-entry-swatch" />
            Public entry
          </span>
          <span>
            <span className="legend-swatch reachable-swatch" />
            Publicly reachable
          </span>
        </div>
      </div>

      <div className="architecture-content">
        <div className="graph-canvas" aria-label="Architecture resource graph">
          <ReactFlow
            edges={edges}
            edgesFocusable={false}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            maxZoom={1.8}
            minZoom={0.15}
            nodes={nodes}
            nodeTypes={nodeTypes}
            nodesDraggable
            onNodesChange={onNodesChange}
            onNodeDragStart={(_event, node) => setSelectedResourceId(node.id)}
            onNodeClick={(_event, node) => setSelectedResourceId(node.id)}
            panOnScroll={false}
            preventScrolling
            zoomOnScroll
          >
            <Background color="#d7e0ea" gap={30} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <ResourceDetails
          graphEdges={edges}
          isPublicEntryPoint={selectedResource ? publicEntryPoints.has(selectedResource.id) : false}
          isPubliclyReachable={
            selectedResource ? publiclyReachableResources.has(selectedResource.id) : false
          }
          resource={selectedResource}
        />
      </div>
    </section>
  );
}

function ResourceGraphNode({ data, selected }: NodeProps<ResourceFlowNode>) {
  const { resource, isPublicEntryPoint, isPubliclyReachable } = data;
  const classes = [
    "resource-flow-node",
    isPubliclyReachable ? "resource-flow-node-reachable" : "",
    isPublicEntryPoint ? "resource-flow-node-public-entry" : "",
    selected ? "resource-flow-node-selected" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <Handle position={Position.Left} type="target" />
      <div className="resource-flow-node-id">{resource.id}</div>
      <div className="resource-flow-node-type">{formatResourceType(resource.type)}</div>
      <Handle position={Position.Right} type="source" />
    </div>
  );
}

function ResourceDetails({
  resource,
  graphEdges,
  isPublicEntryPoint,
  isPubliclyReachable
}: {
  resource: ResourceNode | undefined;
  graphEdges: Edge[];
  isPublicEntryPoint: boolean;
  isPubliclyReachable: boolean;
}) {
  if (resource === undefined) {
    return (
      <aside className="resource-details">
        <h3>Resource Details</h3>
        <p className="muted-note">Select a node to inspect its basic resource details.</p>
      </aside>
    );
  }

  const outgoingEdges = graphEdges.filter((edge) => edge.source === resource.id);
  const incomingEdges = graphEdges.filter((edge) => edge.target === resource.id);
  const propertyCount = Object.keys(resource.properties ?? {}).length;

  return (
    <aside className="resource-details">
      <h3>Resource Details</h3>
      <dl>
        <div>
          <dt>Logical ID</dt>
          <dd>{resource.id}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{resource.type}</dd>
        </div>
        <div>
          <dt>Public Entry Point</dt>
          <dd>{isPublicEntryPoint ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Publicly Reachable</dt>
          <dd>{isPubliclyReachable ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Edges</dt>
          <dd>
            {outgoingEdges.length} outgoing, {incomingEdges.length} incoming
          </dd>
        </div>
        <div>
          <dt>Properties</dt>
          <dd>{propertyCount}</dd>
        </div>
      </dl>
    </aside>
  );
}

function createGraphNodes(
  resources: ResourceNode[],
  edges: ArchitectureEdge[],
  publicEntryPoints: Set<string>,
  publiclyReachableResources: Set<string>
): ResourceFlowNode[] {
  const graphNodes: ResourceFlowNode[] = resources.map((resource) => {
    return {
      id: resource.id,
      type: "resource",
      position: { x: 0, y: 0 },
      data: {
        resource,
        isPublicEntryPoint: publicEntryPoints.has(resource.id),
        isPubliclyReachable: publiclyReachableResources.has(resource.id)
      }
    };
  });

  return layoutGraphNodes(graphNodes, edges, publicEntryPoints);
}

function createGraphEdges(edges: ArchitectureEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: getEdgeKey(edge),
    source: edge.from,
    target: edge.to,
    label: edge.relationship === "references" ? undefined : formatRelationship(edge.relationship),
    type: "smoothstep",
    labelBgBorderRadius: 8,
    labelBgPadding: [6, 3],
    labelBgStyle: {
      fill: "#ffffff",
      fillOpacity: 1
    },
    labelStyle: {
      fill: "#111827",
      fontSize: 18,
      fontWeight: 900
    },
    focusable: false,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: edgeStrokeColor
    },
    selectable: false,
    style: {
      stroke: edgeStrokeColor
    },
    className: edge.relationship === "references" ? "reference-flow-edge" : "typed-flow-edge"
  }));
}

function selectVisibleEdges(
  edges: ArchitectureEdge[],
  resourceIds: Set<string>
): ArchitectureEdge[] {
  const edgesByDirection = new Map<string, ArchitectureEdge[]>();

  for (const edge of edges) {
    if (!resourceIds.has(edge.from) || !resourceIds.has(edge.to)) {
      continue;
    }

    const directionKey = getDirectionalEdgeKey(edge);
    const directionEdges = edgesByDirection.get(directionKey);

    if (directionEdges === undefined) {
      edgesByDirection.set(directionKey, [edge]);
    } else {
      directionEdges.push(edge);
    }
  }

  const visibleEdges: ArchitectureEdge[] = [];

  for (const directionEdges of edgesByDirection.values()) {
    const preferredEdge = getPreferredVisualEdge(directionEdges);

    if (preferredEdge !== undefined) {
      visibleEdges.push(preferredEdge);
    }
  }

  return visibleEdges;
}

function getPreferredVisualEdge(edges: ArchitectureEdge[]): ArchitectureEdge | undefined {
  return (
    edges.find((edge) => edge.relationship !== "references") ??
    edges.find((edge) => edge.relationship === "references")
  );
}

function layoutGraphNodes(
  nodes: ResourceFlowNode[],
  edges: ArchitectureEdge[],
  publicEntryPoints: Set<string>
): ResourceFlowNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const coreNodes = nodes.filter((node) => !isSupportResource(node.data.resource));
  const supportNodes = nodes.filter((node) => isSupportResource(node.data.resource));
  const graph = new dagre.graphlib.Graph();

  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    nodesep: 76,
    ranksep: 160,
    marginx: 24,
    marginy: 24
  });

  for (const node of coreNodes) {
    graph.setNode(node.id, {
      width: graphNodeWidth,
      height: graphNodeHeight
    });
  }

  for (const edge of getCoreLayoutEdges(edges, nodeById, publicEntryPoints)) {
    graph.setEdge(edge.from, edge.to);
  }

  dagre.layout(graph);

  const laidOutCoreNodes = coreNodes.map((node) => {
    const layoutNode = graph.node(node.id);

    if (layoutNode === undefined) {
      return node;
    }

    return {
      ...node,
      position: {
        x: layoutNode.x - graphNodeWidth / 2,
        y: layoutNode.y - graphNodeHeight / 2
      }
    };
  });

  const positionedCoreNodes = new Map(laidOutCoreNodes.map((node) => [node.id, node]));
  const laidOutSupportNodes = layoutSupportNodes(supportNodes, positionedCoreNodes, edges);

  return nodes.map(
    (node) => positionedCoreNodes.get(node.id) ?? laidOutSupportNodes.get(node.id) ?? node
  );
}

function getCoreLayoutEdges(
  edges: ArchitectureEdge[],
  nodeById: Map<string, ResourceFlowNode>,
  publicEntryPoints: Set<string>
): Array<Pick<ArchitectureEdge, "from" | "to">> {
  const layoutEdges: Array<Pick<ArchitectureEdge, "from" | "to">> = [];
  const seenEdges = new Set<string>();

  for (const edge of edges) {
    const layoutEdge = getCoreLayoutEdge(edge, nodeById, publicEntryPoints);

    if (layoutEdge === undefined) {
      continue;
    }

    const edgeKey = `${layoutEdge.from}->${layoutEdge.to}`;

    if (seenEdges.has(edgeKey)) {
      continue;
    }

    seenEdges.add(edgeKey);
    layoutEdges.push(layoutEdge);
  }

  return layoutEdges;
}

function getCoreLayoutEdge(
  edge: ArchitectureEdge,
  nodeById: Map<string, ResourceFlowNode>,
  publicEntryPoints: Set<string>
): Pick<ArchitectureEdge, "from" | "to"> | undefined {
  const source = nodeById.get(edge.from);
  const target = nodeById.get(edge.to);

  if (
    source === undefined ||
    target === undefined ||
    isSupportResource(source.data.resource) ||
    isSupportResource(target.data.resource)
  ) {
    return undefined;
  }

  if (
    edge.relationship === "references" &&
    publicEntryPoints.has(edge.to) &&
    !publicEntryPoints.has(edge.from)
  ) {
    return {
      from: edge.to,
      to: edge.from
    };
  }

  return {
    from: edge.from,
    to: edge.to
  };
}

function layoutSupportNodes(
  supportNodes: ResourceFlowNode[],
  coreNodes: Map<string, ResourceFlowNode>,
  edges: ArchitectureEdge[]
): Map<string, ResourceFlowNode> {
  const supportGroups = new Map<string, ResourceFlowNode[]>();
  const unanchoredSupportNodes: ResourceFlowNode[] = [];

  for (const node of supportNodes) {
    const anchorId = findSupportAnchorId(node.id, edges, coreNodes);

    if (anchorId === undefined) {
      unanchoredSupportNodes.push(node);
      continue;
    }

    const anchoredNodes = supportGroups.get(anchorId);

    if (anchoredNodes === undefined) {
      supportGroups.set(anchorId, [node]);
    } else {
      anchoredNodes.push(node);
    }
  }

  const positionedNodes = new Map<string, ResourceFlowNode>();

  for (const [anchorId, nodes] of supportGroups) {
    const anchor = coreNodes.get(anchorId);

    if (anchor === undefined) {
      continue;
    }

    nodes.forEach((node, index) => {
      positionedNodes.set(node.id, {
        ...node,
        position: {
          x: anchor.position.x,
          y: anchor.position.y + graphNodeHeight + 56 + index * (graphNodeHeight + 34)
        }
      });
    });
  }

  const coreBounds = getNodeBounds([...coreNodes.values()]);
  unanchoredSupportNodes.forEach((node, index) => {
    positionedNodes.set(node.id, {
      ...node,
      position: {
        x: coreBounds.minX,
        y: coreBounds.maxBottom + 48 + index * (graphNodeHeight + 34)
      }
    });
  });

  return positionedNodes;
}

function findSupportAnchorId(
  supportNodeId: string,
  edges: ArchitectureEdge[],
  coreNodes: Map<string, ResourceFlowNode>
): string | undefined {
  const connectedEdge = edges.find(
    (edge) =>
      (edge.from === supportNodeId && coreNodes.has(edge.to)) ||
      (edge.to === supportNodeId && coreNodes.has(edge.from))
  );

  if (connectedEdge === undefined) {
    return undefined;
  }

  return connectedEdge.from === supportNodeId ? connectedEdge.to : connectedEdge.from;
}

function getNodeBounds(nodes: ResourceFlowNode[]): {
  minX: number;
  maxBottom: number;
} {
  if (nodes.length === 0) {
    return {
      minX: 0,
      maxBottom: 0
    };
  }

  return nodes.reduce(
    (bounds, node) => ({
      minX: Math.min(bounds.minX, node.position.x),
      maxBottom: Math.max(bounds.maxBottom, node.position.y + graphNodeHeight)
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxBottom: Number.NEGATIVE_INFINITY
    }
  );
}

function isSupportResource(resource: ResourceNode): boolean {
  return (
    resource.type === "AWS::Lambda::Permission" || resource.type === "AWS::Logs::LogGroup"
  );
}

function getEdgeKey(edge: ArchitectureEdge): string {
  return `${edge.from}-${edge.to}-${edge.relationship}-${edge.evidencePath}`;
}

function getDirectionalEdgeKey(edge: ArchitectureEdge): string {
  return `${edge.from}->${edge.to}`;
}

function formatResourceType(type: string): string {
  const parts = type.split("::");
  return parts.length >= 3 ? parts.slice(1).join("::") : type;
}

function formatRelationship(relationship: ArchitectureEdge["relationship"]): string {
  if (relationship === "dead-letter") {
    return "dead-letter queue";
  }

  return relationship;
}
