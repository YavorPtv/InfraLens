import { useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { analyzeTemplate } from "../api/analyzeTemplate";
import { useAnalysisReport } from "../reportState";

export function AnalyzePage() {
  const [templateJson, setTemplateJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const { setReport } = useAnalysisReport();

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];

    if (file === undefined) {
      return;
    }

    if (!file.name.toLowerCase().endsWith(".json")) {
      setError("Choose a .json CloudFormation template file.");
      event.target.value = "";
      return;
    }

    setTemplateJson(await file.text());
    setError(null);
  }

  async function handleAnalyze(): Promise<void> {
    if (templateJson.trim().length === 0) {
      setError("Paste a CloudFormation template or upload a .json file first.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const report = await analyzeTemplate(templateJson);
      setReport(report);
      navigate("/report");
    } catch (analysisError) {
      setReport(null);
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Template analysis failed. Check the template and try again."
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <section className="page-section analyze-layout">
      <div className="input-toolbar">
        <div>
          <label className="input-label" htmlFor="template-input">
            CloudFormation JSON
          </label>
          <p className="muted-note">Paste a template or upload a local `.json` file.</p>
        </div>
        <div className="file-upload">
          <input
            accept=".json,application/json"
            className="file-input"
            id="template-file"
            onChange={(event) => {
              void handleFileChange(event);
            }}
            ref={fileInputRef}
            type="file"
          />
          <button
            className="secondary-button"
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            Upload JSON
          </button>
        </div>
      </div>

      <textarea
        className="template-input"
        id="template-input"
        onChange={(event) => {
          setTemplateJson(event.target.value);
          setError(null);
        }}
        placeholder='Paste a template here, for example { "Resources": {} }'
        value={templateJson}
      />

      <div className="analyze-actions">
        <button
          className="primary-button"
          disabled={isLoading}
          onClick={() => {
            void handleAnalyze();
          }}
          type="button"
        >
          {isLoading ? "Analyzing..." : "Analyze"}
        </button>
      </div>

      {error !== null ? (
        <div className="error-message" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
