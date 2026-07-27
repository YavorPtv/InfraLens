import type {
  AnalysisReport,
  CfnValue,
  DiffReport,
  Finding,
  PolicySuggestion,
  ResourceNode,
  Severity,
  SeverityCounts
} from "./index";

const severityOrder: Severity[] = ["critical", "high", "medium", "low"];

export function exportAnalysisReportToJson(report: AnalysisReport): string {
  return JSON.stringify(report, null, 2);
}

export function exportAnalysisReportToMarkdown(report: AnalysisReport): string {
  return [
    "# InfraLens Analysis Report",
    "",
    "## Score",
    "",
    `${report.score}/100`,
    "",
    "## Severity Summary",
    "",
    ...formatSeveritySummary(report.summary.bySeverity),
    "",
    `Total findings: ${report.summary.totalFindings}`,
    "",
    "## Findings",
    "",
    ...formatFindings(report.findings),
    "",
    "## Public Exposure",
    "",
    `- Entry points: ${formatInlineList(report.publicEntryPointIds)}`,
    `- Reachable resources: ${formatInlineList(report.publiclyReachableResourceIds)}`,
    "",
    "## Least-Privilege Suggestions",
    "",
    ...formatLeastPrivilegeSuggestions(report.leastPrivilegeSuggestions)
  ].join("\n");
}

export function exportDiffReportToMarkdown(report: DiffReport): string {
  return [
    "# InfraLens Diff Report",
    "",
    "## Score Change",
    "",
    `- Old score: ${report.oldReport.score}/100`,
    `- New score: ${report.newReport.score}/100`,
    "",
    "## New Report Severity Summary",
    "",
    ...formatSeveritySummary(report.newReport.summary.bySeverity),
    "",
    "## Resource Changes",
    "",
    "### Added Resources",
    "",
    ...formatResources(report.resources.added),
    "",
    "### Removed Resources",
    "",
    ...formatResources(report.resources.removed),
    "",
    "### Changed Resources",
    "",
    ...formatChangedResources(report.resources.changed),
    "",
    "## Risk Changes",
    "",
    "### Introduced Findings",
    "",
    ...formatFindings(report.findings.introduced),
    "",
    "### Resolved Findings",
    "",
    ...formatFindings(report.findings.resolved),
    "",
    "### Unchanged Findings",
    "",
    ...formatFindings(report.findings.unchanged),
    "",
    "## Least-Privilege Suggestions",
    "",
    ...formatLeastPrivilegeSuggestions(report.newReport.leastPrivilegeSuggestions)
  ].join("\n");
}

function formatSeveritySummary(counts: SeverityCounts): string[] {
  return severityOrder.map((severity) => `- ${formatSeverity(severity)}: ${counts[severity]}`);
}

function formatFindings(findings: Finding[]): string[] {
  if (findings.length === 0) {
    return ["No findings."];
  }

  return findings.flatMap((finding) => [
    `### ${finding.title}`,
    "",
    `- Rule: \`${finding.ruleId}\``,
    `- Severity: ${formatSeverity(finding.severity)}`,
    `- Resource: \`${finding.resourceId}\``,
    `- Evidence path: \`${finding.evidencePath}\``,
    `- Explanation: ${finding.explanation}`,
    `- Suggestion: ${finding.suggestion}`,
    ...formatSeverityAdjustment(finding),
    ""
  ]);
}

function formatSeverityAdjustment(finding: Finding): string[] {
  if (finding.severityAdjustment === undefined) {
    return [];
  }

  return [
    `- Severity adjustment: ${formatSeverity(finding.severityAdjustment.from)} to ${formatSeverity(
      finding.severityAdjustment.to
    )}`,
    `- Adjustment reason: ${finding.severityAdjustment.reason}`
  ];
}

function formatLeastPrivilegeSuggestions(suggestions: PolicySuggestion[]): string[] {
  if (suggestions.length === 0) {
    return [
      'No least-privilege suggestions. No broad service-specific Resource "*" permissions could be safely narrowed from template references.'
    ];
  }

  return suggestions.flatMap((suggestion) => [
    `### ${suggestion.roleId} ${suggestion.service} policy`,
    "",
    `- Lambda function: \`${suggestion.lambdaFunctionId}\``,
    `- Policy: ${formatPolicyLocation(suggestion)}`,
    `- Confidence: ${formatSeverityLike(suggestion.confidence)}`,
    `- Current actions: ${formatInlineList(suggestion.currentActions)}`,
    `- Suggested actions: ${formatInlineList(suggestion.suggestedActions)}`,
    `- Current resource: \`${formatCfnValue(suggestion.currentResource)}\``,
    `- Suggested resources: ${formatSuggestedResources(suggestion)}`,
    `- Evidence path: \`${suggestion.evidence.statementEvidencePath}\``,
    `- Suggestion: ${suggestion.explanation}`,
    ...formatSourceActionEvidence(suggestion),
    ""
  ]);
}

function formatPolicyLocation(suggestion: PolicySuggestion): string {
  if (suggestion.policyResourceId !== undefined) {
    return `\`${suggestion.policyResourceId}${formatOptionalName(suggestion.policyName)}\``;
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
    .map(
      (resource) =>
        `\`${resource.resourceId}\` (${resource.resourceType}, evidence: \`${resource.referenceEvidencePath}\`) -> \`${formatCfnValue(
          resource.suggestedResource
        )}\``
    )
    .join("; ");
}

function formatSourceActionEvidence(suggestion: PolicySuggestion): string[] {
  const sourceActions = suggestion.evidence.sourceActions ?? [];
  if (sourceActions.length === 0) {
    return [];
  }

  return [
    "- Source action evidence:",
    ...sourceActions.map(
      (action) =>
        `  - \`${action.action}\` from \`${action.filePath}\` for Lambda \`${action.lambdaFunctionId}\` matched \`${action.matchedCommand}\` (${action.confidence} confidence, evidence: \`${action.evidence}\`)`
    )
  ];
}

function formatResources(resources: ResourceNode[]): string[] {
  if (resources.length === 0) {
    return ["None."];
  }

  return resources.map((resource) => `- \`${resource.id}\` (${resource.type})`);
}

function formatChangedResources(
  resources: Array<{ resourceId: string; oldResource: ResourceNode; newResource: ResourceNode }>
): string[] {
  if (resources.length === 0) {
    return ["None."];
  }

  return resources.map(
    (resource) =>
      `- \`${resource.resourceId}\`: ${resource.oldResource.type} -> ${resource.newResource.type}`
  );
}

function formatInlineList(values: string[]): string {
  if (values.length === 0) {
    return "None.";
  }

  return values.map((value) => `\`${value}\``).join(", ");
}

function formatCfnValue(value: CfnValue): string {
  return JSON.stringify(value);
}

function formatSeverity(severity: Severity): string {
  return formatSeverityLike(severity);
}

function formatSeverityLike(value: string): string {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
