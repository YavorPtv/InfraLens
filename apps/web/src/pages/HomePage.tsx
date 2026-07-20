import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <section className="page-section">
      <div className="intro-grid">
        <div>
          <p className="lede">
            InfraLens reviews CloudFormation templates, highlights risky resources, and prepares
            architecture data for security-focused reports.
          </p>
          <div className="actions">
            <Link className="primary-button" to="/analyze">
              Analyze Template
            </Link>
            <Link className="secondary-button" to="/report">
              View Report Placeholder
            </Link>
          </div>
        </div>

        <dl className="summary-list" aria-label="Current analyzer outputs">
          <div>
            <dt>Findings</dt>
            <dd>Security and reliability risks with evidence paths.</dd>
          </div>
          <div>
            <dt>Graph</dt>
            <dd>Resources, references, runtime edges, and reachability.</dd>
          </div>
          <div>
            <dt>Suggestions</dt>
            <dd>Template-only least-privilege resource narrowing hints.</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
