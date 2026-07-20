import type { Finding, Severity } from "@infralens/shared";

export const severityOrder: Severity[] = ["critical", "high", "medium", "low"];

export type SeverityFilter = Severity | "all";

export function formatSeverity(severity: Severity): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

export function groupFindingsBySeverity(findings: Finding[]): Record<Severity, Finding[]> {
  return severityOrder.reduce(
    (grouped, severity) => {
      grouped[severity] = findings.filter((finding) => finding.severity === severity);
      return grouped;
    },
    {
      low: [],
      medium: [],
      high: [],
      critical: []
    } as Record<Severity, Finding[]>
  );
}
