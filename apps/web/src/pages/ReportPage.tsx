export function ReportPage() {
  return (
    <section className="page-section report-placeholder">
      <div>
        <h2>Report Workspace</h2>
        <p>
          This space will show score, severity summary, findings, public exposure, architecture
          edges, and least-privilege suggestions after the analyzer is connected.
        </p>
      </div>
      <div className="placeholder-panel" aria-label="Report placeholder">
        <div className="placeholder-row wide" />
        <div className="placeholder-row" />
        <div className="placeholder-row short" />
      </div>
    </section>
  );
}
