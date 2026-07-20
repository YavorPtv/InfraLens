import { useMemo, useState } from "react";
import type { Finding } from "@infralens/shared";
import {
  formatSeverity,
  groupFindingsBySeverity,
  severityOrder,
  type SeverityFilter
} from "./reportModel";

interface FindingsReportProps {
  findings: Finding[];
}

export function FindingsReport({ findings }: FindingsReportProps) {
  const [selectedSeverity, setSelectedSeverity] = useState<SeverityFilter>("all");
  const groupedFindings = useMemo(() => groupFindingsBySeverity(findings), [findings]);
  const visibleSeverities =
    selectedSeverity === "all" ? severityOrder : severityOrder.filter((severity) => severity === selectedSeverity);

  return (
    <section className="report-panel findings-panel">
      <div className="section-heading findings-heading">
        <div>
          <h2>Findings</h2>
          <p className="muted-note">Grouped by severity with evidence and remediation guidance.</p>
        </div>
        {findings.length > 0 ? (
          <SeverityFilterControl
            selectedSeverity={selectedSeverity}
            setSelectedSeverity={setSelectedSeverity}
          />
        ) : null}
      </div>

      {findings.length === 0 ? (
        <p className="empty-state">No findings were detected.</p>
      ) : (
        <div className="finding-groups">
          {visibleSeverities.map((severity) => {
            const severityFindings = groupedFindings[severity];

            if (severityFindings.length === 0) {
              return null;
            }

            return (
              <section className="finding-group" key={severity}>
                <div className="finding-group-header">
                  <h3>{formatSeverity(severity)}</h3>
                  <span>{severityFindings.length}</span>
                </div>
                <ul className="finding-card-list">
                  {severityFindings.map((finding) => (
                    <FindingCard finding={finding} key={getFindingKey(finding)} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

interface SeverityFilterControlProps {
  selectedSeverity: SeverityFilter;
  setSelectedSeverity: (severity: SeverityFilter) => void;
}

function SeverityFilterControl({
  selectedSeverity,
  setSelectedSeverity
}: SeverityFilterControlProps) {
  const filters: SeverityFilter[] = ["all", ...severityOrder];

  return (
    <div className="severity-filter" aria-label="Filter findings by severity">
      {filters.map((severity) => (
        <button
          aria-pressed={selectedSeverity === severity}
          key={severity}
          onClick={() => setSelectedSeverity(severity)}
          type="button"
        >
          {severity === "all" ? "All" : formatSeverity(severity)}
        </button>
      ))}
    </div>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <li className="finding-card">
      <div className="finding-card-header">
        <span className={`severity-pill severity-${finding.severity}`}>
          {formatSeverity(finding.severity)}
        </span>
        <span className="resource-id">{finding.resourceId}</span>
      </div>

      <h4>{finding.title}</h4>
      <p>{finding.explanation}</p>

      <dl className="finding-evidence">
        <div>
          <dt>Evidence</dt>
          <dd>{finding.evidencePath}</dd>
        </div>
        <div>
          <dt>Suggestion</dt>
          <dd>{finding.suggestion}</dd>
        </div>
      </dl>
    </li>
  );
}

function getFindingKey(finding: Finding): string {
  return `${finding.ruleId}-${finding.resourceId}-${finding.evidencePath}`;
}
