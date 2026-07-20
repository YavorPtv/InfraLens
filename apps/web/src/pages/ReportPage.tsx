import { Link } from "react-router-dom";
import { useAnalysisReport } from "../reportState";

export function ReportPage() {
  const { report } = useAnalysisReport();

  if (report === null) {
    return (
      <section className="page-section report-placeholder">
        <div>
          <h2>No Report Yet</h2>
          <p>Analyze a CloudFormation template to populate this report workspace.</p>
          <Link className="primary-button" to="/analyze">
            Analyze Template
          </Link>
        </div>
        <div className="placeholder-panel" aria-label="Report placeholder">
          <div className="placeholder-row wide" />
          <div className="placeholder-row" />
          <div className="placeholder-row short" />
        </div>
      </section>
    );
  }

  return (
    <section className="page-section report-summary">
      <div className="metric-grid" aria-label="Analysis summary">
        <div className="metric-card">
          <span>Score</span>
          <strong>{report.score}/100</strong>
        </div>
        <div className="metric-card">
          <span>Findings</span>
          <strong>{report.summary.totalFindings}</strong>
        </div>
        <div className="metric-card">
          <span>Resources</span>
          <strong>{report.resources.length}</strong>
        </div>
        <div className="metric-card">
          <span>Edges</span>
          <strong>{report.edges.length}</strong>
        </div>
      </div>

      <div className="report-details">
        <section>
          <h2>Severity Summary</h2>
          <dl className="severity-list">
            <div>
              <dt>Critical</dt>
              <dd>{report.summary.bySeverity.critical}</dd>
            </div>
            <div>
              <dt>High</dt>
              <dd>{report.summary.bySeverity.high}</dd>
            </div>
            <div>
              <dt>Medium</dt>
              <dd>{report.summary.bySeverity.medium}</dd>
            </div>
            <div>
              <dt>Low</dt>
              <dd>{report.summary.bySeverity.low}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h2>Findings</h2>
          {report.findings.length === 0 ? (
            <p className="muted-note">No findings were detected.</p>
          ) : (
            <ul className="finding-list">
              {report.findings.slice(0, 6).map((finding) => (
                <li key={`${finding.ruleId}-${finding.resourceId}-${finding.evidencePath}`}>
                  <div>
                    <strong>{finding.title}</strong>
                    <span>{finding.resourceId}</span>
                  </div>
                  <span className={`severity-pill severity-${finding.severity}`}>
                    {finding.severity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
