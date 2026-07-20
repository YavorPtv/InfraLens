import type { AnalysisSummary } from "@infralens/shared";
import { formatSeverity, severityOrder } from "./reportModel";

interface SeveritySummaryProps {
  summary: AnalysisSummary;
}

export function SeveritySummary({ summary }: SeveritySummaryProps) {
  return (
    <section className="report-panel">
      <div className="section-heading">
        <h2>Severity Summary</h2>
        <p className="muted-note">Finding counts by final adjusted severity.</p>
      </div>

      <dl className="severity-list">
        {severityOrder.map((severity) => (
          <div key={severity}>
            <dt>
              <span className={`severity-dot severity-dot-${severity}`} />
              {formatSeverity(severity)}
            </dt>
            <dd>{summary.bySeverity[severity]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
