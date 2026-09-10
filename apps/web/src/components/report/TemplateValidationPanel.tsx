import type { AnalysisStatus, TemplateValidationResult } from "@infralens/shared";

export function TemplateValidationPanel({ validation, analysisStatus, title = "Original template validation" }: {
  validation: TemplateValidationResult;
  analysisStatus?: AnalysisStatus;
  title?: string;
}) {
  const failed = validation.parse === "invalid" || validation.structure === "invalid" || validation.cloudFormation === "invalid";
  return <section className="report-panel template-validation-panel" aria-label={title}>
    <h3>{title}</h3>
    <ul>
      <li>Parse: <strong>{validation.parse}</strong></li>
      <li>CloudFormation structure: <strong>{validation.structure}</strong></li>
      {analysisStatus !== undefined && <li>Analyzer: <strong>{analysisStatus}</strong></li>}
      <li>AWS CloudFormation validation: <strong>{validation.cloudFormation}</strong></li>
    </ul>
    {failed && <p className="error-message" role="alert">Template validation failed. Review the issues below.</p>}
    {(validation.cloudFormation === "not-run" || validation.cloudFormation === "unavailable") &&
      <div className="validation-warning" role="status">
        <span className="validation-warning-icon" aria-hidden="true">!</span>
        <div>
          <strong>AWS validation was not performed</strong>
          <p>Local checks cover template structure only.</p>
        </div>
      </div>}
    {validation.issues.length > 0 && <details open={failed}>
      <summary>Validation issues ({validation.issues.length})</summary>
      <ul>{validation.issues.map((issue, index) => <li key={index}>
        <strong>{issue.code}</strong>{issue.path && ` — ${issue.path}`}: {issue.message}
        {!!issue.relatedFixIds?.length && <p>Possible contributing fixes: {issue.relatedFixIds.join(", ")}</p>}
      </li>)}</ul>
    </details>}
    <p className="muted-note">Passing validation does not guarantee stack deployment will succeed.</p>
  </section>;
}
