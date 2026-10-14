import { formatValidationSummary } from "./validation";
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
import type { SourceActionEvidence } from "./index";

const severityOrder: Severity[] = ["critical", "high", "medium", "low"];

export function exportAnalysisReportToJson(report: AnalysisReport): string {
  return JSON.stringify(report, null, 2);
}

export function exportAnalysisReportToMarkdown(report: AnalysisReport): string {
  return [
    "# InfraLens Analysis Report",
    "",
    "## Template validation",
    "",
    ...formatValidationSummary(report.validation, report.analysisStatus).map(line => `- ${line}`),
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
    ...formatLeastPrivilegeSuggestions(report.leastPrivilegeSuggestions),
    ...formatAnalysisLimitations(report)
  ].join("\n");
}

function formatAnalysisLimitations(report: AnalysisReport): string[] {
  const limitations = [...(report.iamAnalysis?.limitations ?? []), ...(report.sourceAnalysisWarnings ?? [])];
  return limitations.length ? ["", "## Analysis limitations", "", ...limitations.map(value => `- ${value}`)] : [];
}

export function exportDiffReportToMarkdown(report: DiffReport): string {
  return [
    "# InfraLens Diff Report",
    "",
    "## Original template validation",
    ...formatValidationSummary(report.oldReport.validation, report.oldReport.analysisStatus),
    "",
    "## New template validation",
    ...formatValidationSummary(report.newReport.validation, report.newReport.analysisStatus),
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
    ...formatSourceComparison(report),
    "",
    "## Least-Privilege Suggestions",
    "",
    ...formatLeastPrivilegeSuggestions(report.newReport.leastPrivilegeSuggestions)
  ].join("\n");
}

function formatSourceComparison(report: DiffReport): string[] {
  const source = report.source;
  const suggestions = report.suggestions;
  if (!source) return ["", "## Source comparison", "", "Source comparison metadata unavailable in this report."];
  return ["", "## Source / IAM Evidence Changes", "",
    `- Old source: ${source.old.status} (${source.old.fileCount} files)`,
    `- New source: ${source.new.status} (${source.new.fileCount} files)`,
    ...source.warnings.map(warning => `- ${warning}`),
    "", "### Newly inferred actions", "", ...formatInferredActions(source.added),
    "", "### Actions no longer observed", "", ...formatInferredActions(source.noLongerObserved),
    "", "### Changed action evidence", "",
    ...(source.changed.length ? source.changed.flatMap(change => ["Old:", ...formatInferredActions([change.old]),
      "New:", ...formatInferredActions([change.new])]) : ["None."]),
    "", "### Unchanged inferred actions", "", ...formatInferredActions(source.unchanged),
    ...(suggestions ? ["", "## Least-Privilege Suggestion Changes", "",
      "Suggestions are recommendations; this comparison does not change deployed permissions.",
      "", "### Added suggestions", "", ...formatLeastPrivilegeSuggestions(suggestions.added),
      "", "### Removed suggestions", "", ...formatLeastPrivilegeSuggestions(suggestions.removed),
      "", "### Changed suggestions", "",
      ...(suggestions.changed.length ? suggestions.changed.flatMap(change => [
        "Before:", ...formatLeastPrivilegeSuggestions([change.old]), "After:", ...formatLeastPrivilegeSuggestions([change.new])
      ]) : ["None."]), `Unchanged suggestions: ${suggestions.unchanged.length}`] : [])
  ];
}

function formatInferredActions(actions: SourceActionEvidence[]): string[] {
  return actions.length ? actions.flatMap(action => [
    `- ${action.action}: Lambda ${action.lambdaFunctionId ?? "unresolved"}; ${action.filePath}; command ${action.matchedCommand}; mapping confidence ${action.confidence}; action confidence ${action.actionConfidence ?? "unknown"}`,
    `  - Evidence: ${action.evidence}${action.useLocation ? `; use ${action.useLocation.line}:${action.useLocation.column}` : ""}`,
    ...(action.rootFilePath ? [`  - Root: ${action.rootFilePath}; imports: ${(action.importChain ?? []).join(" -> ")}`] : []),
    ...(action.limitations ?? []).map(warning => `  - Limitation: ${warning}`)
  ]) : ["None."];
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
    ...(suggestion.manualOnly ? [`- Manual review required: ${suggestion.manualReviewReason ?? "Inference is incomplete."}`] : []),
    ...(suggestion.suggestedStatements ? ["", "```json", JSON.stringify(suggestion.suggestedStatements, null, 2), "```"] : []),
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
        `  - \`${action.action}\` from \`${action.filePath}\` for Lambda \`${action.lambdaFunctionId}\` matched \`${action.matchedCommand}\` (${action.confidence} confidence, evidence: \`${action.evidence}\`)${
          action.importChain === undefined
            ? ""
            : `; handler root: \`${action.rootFilePath}\`; import chain: ${action.importChain
                .map((filePath) => `\`${filePath}\``)
                .join(" -> ")}`
        }${action.sdkPackage ? `; SDK package: \`${action.sdkPackage}\`` : ""}${action.useLocation ? `; command use: ${action.useLocation.line}:${action.useLocation.column}` : ""}`
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
