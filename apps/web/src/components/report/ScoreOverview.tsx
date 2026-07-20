import type { AnalysisReport } from "@infralens/shared";

interface ScoreOverviewProps {
  report: AnalysisReport;
}

export function ScoreOverview({ report }: ScoreOverviewProps) {
  return (
    <section className="score-overview" aria-label="Analysis overview">
      <div className="score-panel">
        <span className="metric-label">Architecture score</span>
        <strong>{report.score}</strong>
        <span className="score-scale">out of 100</span>
      </div>

      <div className="metric-grid" aria-label="Report totals">
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
        <div className="metric-card">
          <span>Public</span>
          <strong>{report.publiclyReachableResourceIds.length}</strong>
        </div>
      </div>
    </section>
  );
}
