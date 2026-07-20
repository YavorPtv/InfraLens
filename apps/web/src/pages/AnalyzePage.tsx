export function AnalyzePage() {
  return (
    <section className="page-section analyze-layout">
      <label className="input-label" htmlFor="template-input">
        CloudFormation JSON
      </label>
      <textarea
        className="template-input"
        id="template-input"
        placeholder='Paste a template here, for example { "Resources": {} }'
      />
      <div className="analyze-actions">
        <button className="primary-button" disabled type="button">
          Analyze
        </button>
        <span className="muted-note">API wiring arrives in the next frontend step.</span>
      </div>
    </section>
  );
}
