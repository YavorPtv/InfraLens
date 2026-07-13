import type { AnalysisReport, Severity } from "@infralens/shared";

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
    "Findings:"
  ];

  if (report.findings.length === 0) {
    lines.push("  No findings.");
    return lines.join("\n");
  }

  for (const finding of report.findings) {
    lines.push(`  [${finding.severity.toUpperCase()}] ${finding.resourceId} - ${finding.title}`);
    lines.push(`    Suggestion: ${finding.suggestion}`);
  }

  return lines.join("\n");
}

function formatSeverity(severity: Severity): string {
  return `${severity[0].toUpperCase()}${severity.slice(1)}`;
}
