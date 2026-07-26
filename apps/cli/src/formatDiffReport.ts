import type { DiffReport, Finding, ResourceNode, Severity } from "@infralens/shared";

const severeIntroducedFindings: Severity[] = ["critical", "high"];

export function formatDiffReport(report: DiffReport): string {
  return [
    "InfraLens Diff Summary",
    `Old score: ${report.oldReport.score}/100`,
    `New score: ${report.newReport.score}/100`,
    "",
    "Resource changes:",
    "  Added resources:",
    ...formatResources(report.resources.added),
    "  Removed resources:",
    ...formatResources(report.resources.removed),
    "  Changed resources:",
    ...formatChangedResources(report.resources.changed),
    "",
    "Risk changes:",
    "  Newly introduced findings:",
    ...formatIntroducedFindings(report.findings.introduced),
    "  Resolved findings:",
    ...formatFindings(report.findings.resolved),
    "  Unchanged findings:",
    ...formatFindings(report.findings.unchanged)
  ].join("\n");
}

function formatResources(resources: ResourceNode[]): string[] {
  if (resources.length === 0) {
    return ["    None."];
  }

  return resources.map((resource) => `    - ${resource.id} (${resource.type})`);
}

function formatChangedResources(
  resources: Array<{ resourceId: string; oldResource: ResourceNode; newResource: ResourceNode }>
): string[] {
  if (resources.length === 0) {
    return ["    None."];
  }

  return resources.map(
    (resource) =>
      `    - ${resource.resourceId} (${resource.oldResource.type} -> ${resource.newResource.type})`
  );
}

function formatIntroducedFindings(findings: Finding[]): string[] {
  if (findings.length === 0) {
    return ["    None."];
  }

  return findings.flatMap((finding) => {
    const prefix = severeIntroducedFindings.includes(finding.severity)
      ? `[NEW ${finding.severity.toUpperCase()} RISK]`
      : `[${finding.severity.toUpperCase()}]`;

    return formatFinding(finding, prefix);
  });
}

function formatFindings(findings: Finding[]): string[] {
  if (findings.length === 0) {
    return ["    None."];
  }

  return findings.flatMap((finding) => formatFinding(finding, `[${finding.severity.toUpperCase()}]`));
}

function formatFinding(finding: Finding, prefix: string): string[] {
  return [
    `    - ${prefix} ${finding.resourceId} - ${finding.title}`,
    `      Rule: ${finding.ruleId}`,
    `      Evidence: ${finding.evidencePath}`,
    `      Suggestion: ${finding.suggestion}`
  ];
}
