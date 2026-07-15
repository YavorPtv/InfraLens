import type {
  AnalysisReport,
  ArchitectureEdge,
  PolicySuggestion,
  Severity
} from "@infralens/shared";

const severityOrder: Severity[] = ["critical", "high", "medium", "low"];

export function formatAnalysisReport(report: AnalysisReport): string {
  const lines = [
    "InfraLens Analysis Summary",
    `Score: ${report.score}/100`,
    `Findings: ${report.summary.totalFindings}`,
    "Severity counts:",
    ...severityOrder.map((severity) => {
      return `  ${formatSeverity(severity)}: ${report.summary.bySeverity[severity]}`;
    }),
    "",
    "Findings:",
    ...formatFindings(report),
    "",
    "Public exposure:",
    `  Entry points: ${formatInlineResourceIds(report.publicEntryPointIds)}`,
    `  Reachable resources: ${formatInlineResourceIds(report.publiclyReachableResourceIds)}`,
    "",
    "Architecture edges:",
    ...formatArchitectureEdges(report.edges),
    "",
    "Least-privilege suggestions:",
    ...formatLeastPrivilegeSuggestions(report.leastPrivilegeSuggestions)
  ];

  return lines.join("\n");
}

function formatFindings(report: AnalysisReport): string[] {
  if (report.findings.length === 0) {
    return ["  No findings."];
  }

  const lines: string[] = [];
  for (const finding of report.findings) {
    lines.push(`  [${finding.severity.toUpperCase()}] ${finding.resourceId} - ${finding.title}`);
    lines.push(`    Evidence: ${finding.evidencePath}`);
    lines.push(`    Suggestion: ${finding.suggestion}`);
    if (finding.severityAdjustment !== undefined) {
      lines.push(
        `    Severity adjusted: ${finding.severityAdjustment.from} -> ${finding.severityAdjustment.to}`
      );
      lines.push(`    Reason: ${finding.severityAdjustment.reason}`);
    }
  }

  return lines;
}

function formatInlineResourceIds(resourceIds: string[]): string {
  if (resourceIds.length === 0) {
    return "None.";
  }

  return resourceIds.join(", ");
}

function formatArchitectureEdges(edges: ArchitectureEdge[]): string[] {
  if (edges.length === 0) {
    return ["  None."];
  }

  const runtimeEdges = edges.filter((edge) => !isTemplateReferenceEdge(edge));
  const templateReferenceEdges = edges.filter(isTemplateReferenceEdge);

  return [
    "  Runtime:",
    ...formatEdgeGroup(runtimeEdges),
    "  Template references:",
    ...formatEdgeGroup(templateReferenceEdges)
  ];
}

function formatEdgeGroup(edges: ArchitectureEdge[]): string[] {
  if (edges.length === 0) {
    return ["    None."];
  }

  return edges.flatMap((edge) => [
    `    - [${edge.relationship}] ${edge.from} -> ${edge.to}`,
    `      Evidence: ${edge.evidencePath}`
  ]);
}

function isTemplateReferenceEdge(edge: ArchitectureEdge): boolean {
  return edge.relationship === "references" || edge.relationship === "depends-on";
}

function formatLeastPrivilegeSuggestions(suggestions: PolicySuggestion[]): string[] {
  if (suggestions.length === 0) {
    return [
      '  None. No broad service-specific Resource "*" permissions could be safely narrowed from template references.'
    ];
  }

  return suggestions.flatMap((suggestion) => [
    `  - [${suggestion.confidence.toUpperCase()}] ${suggestion.lambdaFunctionId} role ${suggestion.roleId} ${suggestion.service} actions: ${suggestion.actions.join(", ")}`,
    `    Policy: ${formatPolicyLocation(suggestion)}`,
    `    Current Resource: ${formatCfnValue(suggestion.currentResource)}`,
    `    Suggested Resource: ${formatSuggestedResources(suggestion)}`,
    `    Evidence: ${suggestion.evidence.statementEvidencePath}`,
    `    Note: ${suggestion.explanation}`
  ]);
}

function formatPolicyLocation(suggestion: PolicySuggestion): string {
  if (suggestion.policyResourceId !== undefined) {
    return `${suggestion.policyResourceId}${formatOptionalName(suggestion.policyName)}`;
  }

  return `inline role policy${formatOptionalName(suggestion.policyName)}`;
}

function formatOptionalName(name: string | undefined): string {
  return name === undefined ? "" : ` (${name})`;
}

function formatSuggestedResources(suggestion: PolicySuggestion): string {
  if (suggestion.suggestedResources.length === 0) {
    return "No safe template-only resource inferred.";
  }

  return suggestion.suggestedResources
    .map((resource) => `${resource.resourceId} => ${formatCfnValue(resource.suggestedResource)}`)
    .join("; ");
}

function formatCfnValue(value: unknown): string {
  return JSON.stringify(value);
}

function formatSeverity(severity: Severity): string {
  return `${severity[0].toUpperCase()}${severity.slice(1)}`;
}
