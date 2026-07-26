import { Link } from "react-router-dom";
import { exportAnalysisReportToJson, exportAnalysisReportToMarkdown } from "@infralens/shared";
import { useAnalysisReport } from "../reportState";
import { ArchitectureGraph } from "../components/report/ArchitectureGraph";
import { FindingsReport } from "../components/report/FindingsReport";
import { LeastPrivilegeSuggestions } from "../components/report/LeastPrivilegeSuggestions";
import { ScoreOverview } from "../components/report/ScoreOverview";
import { SeveritySummary } from "../components/report/SeveritySummary";
import { downloadTextFile } from "../downloadTextFile";

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
      <div className="report-export-bar">
        <div>
          <h2>Analysis Report</h2>
          <p className="muted-note">Download the current analysis report for sharing or review.</p>
        </div>
        <div className="report-export-actions">
          <button
            className="secondary-button"
            onClick={() =>
              downloadTextFile({
                contents: exportAnalysisReportToJson(report),
                fileName: "infralens-analysis-report.json",
                mimeType: "application/json"
              })
            }
            type="button"
          >
            Download JSON
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              downloadTextFile({
                contents: exportAnalysisReportToMarkdown(report),
                fileName: "infralens-analysis-report.md",
                mimeType: "text/markdown"
              })
            }
            type="button"
          >
            Download Markdown
          </button>
        </div>
      </div>
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
