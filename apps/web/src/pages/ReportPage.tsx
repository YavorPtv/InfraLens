import { Link } from "react-router-dom";
import { useAnalysisReport } from "../reportState";
import { ArchitectureGraph } from "../components/report/ArchitectureGraph";
import { FindingsReport } from "../components/report/FindingsReport";
import { LeastPrivilegeSuggestions } from "../components/report/LeastPrivilegeSuggestions";
import { ScoreOverview } from "../components/report/ScoreOverview";
import { SeveritySummary } from "../components/report/SeveritySummary";

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
      <ScoreOverview report={report} />
      <ArchitectureGraph report={report} />
      <LeastPrivilegeSuggestions suggestions={report.leastPrivilegeSuggestions} />

      <div className="report-grid">
        <SeveritySummary summary={report.summary} />
        <FindingsReport findings={report.findings} />
      </div>
    </section>
  );
}
