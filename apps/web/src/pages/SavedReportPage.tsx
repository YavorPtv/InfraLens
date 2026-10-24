import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { SavedRun } from "@infralens/shared";
import { historyClient, saveRequestKey } from "../api/history";
import { restoreSavedReport } from "../api/historyClient";
import { useAnalysisReport } from "../reportState";
import { ReportPage } from "./ReportPage";

export function SavedReportPage() {
  const { projectId = "", runId = "" } = useParams();
  const { report, originalTemplateInput, originalSource, setReport, setOriginalTemplateInput, setOriginalSource } = useAnalysisReport();
  const navigate = useNavigate();
  const [isReanalyzing, setIsReanalyzing] = useState(false);
  const [templateOnly, setTemplateOnly] = useState(false);
  const [retainSource, setRetainSource] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [run, setRun] = useState<SavedRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setRun(null);
    setError(null);
    setActionError(null);
    setTemplateOnly(false);
    setRetainSource(false);
    setReport(null);
    setOriginalTemplateInput(null);
    setOriginalSource(undefined);
    void restoreSavedReport(historyClient, projectId, runId, {
      setOriginalSource: (source) => { if (active) setOriginalSource(source); },
      setReport: (report) => {
        if (active) {
          setReport(report);
        }
      },
      setOriginalTemplateInput: (template) => {
        if (active) {
          setOriginalTemplateInput(template);
        }
      }
    })
      .then((result) => {
        if (!active) {
          return;
        }
        setRun(result.run);
      })
      .catch((error) => {
        if (active) {
          setError(error.message);
        }
      });
    return () => {
      active = false;
    };
  }, [projectId, runId, setReport, setOriginalTemplateInput, setOriginalSource]);
  async function reanalyze(): Promise<void> {
    setIsReanalyzing(true);
    setActionError(null);
    try {
      const idempotencyKey = await saveRequestKey(projectId, { kind: "reanalysis", runId, templateOnly }, retainSource);
      const result = await historyClient.reanalyze(projectId, runId, { idempotencyKey, templateOnly, retainSource });
      sessionStorage.removeItem(`infralens-save-${projectId}`);
      navigate(`/projects/${projectId}/runs/${result.run.runId}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Reanalysis failed.");
    } finally {
      setIsReanalyzing(false);
    }
  }
  if (error) {
    return (
      <section className="page-section">
        <p role="alert">{error}</p>
        <Link to="/projects">Saved projects</Link>
      </section>
    );
  }
  if (!run || run.runId !== runId) {
    return <p role="status">Loading saved report…</p>;
  }
  return (
    <>
      <section className="page-section">
        <Link to={`/projects/${projectId}`}>Back to history</Link>
        <p>Stored report from {new Date(run.createdAt).toLocaleString()}. Opening it does not run the analyzer again.</p>
        {run.provenance && <p>{run.provenance.kind === "apply" ? "Applied fixes" : "Explicit reanalysis"} · {run.provenance.inputMode} inputs · <Link to={`/projects/${projectId}/runs/${run.provenance.parentRun.runId}`}>Original run</Link></p>}
        <p className="muted-note">
          Inputs expire {new Date(run.inputExpiresAt).toLocaleString()}. Source{" "}
          {run.sourceRetained ? "retained" : "not retained"}.
          {Date.parse(run.inputExpiresAt) <= Date.now() &&
            " Inputs have expired. Reupload to reanalyze, apply fixes or compare."}
        </p>
        <p>Reanalyze with the current analyzer and save a linked run. Reports and original inputs stay unchanged.</p>
        {!run.sourceRetained && (
          <p><label>
            <input type="checkbox" checked={templateOnly} onChange={event => setTemplateOnly(event.target.checked)} />{" "}
            Reanalyze template only (source unavailable)
          </label></p>
        )}
        {run.sourceRetained && (
          <p><label>
            <input type="checkbox" checked={retainSource} onChange={event => setRetainSource(event.target.checked)} />{" "}
            Retain source in the new run for 7 days
          </label></p>
        )}
        <button className="secondary-button" disabled={isReanalyzing || originalTemplateInput === null} onClick={() => void reanalyze()}>Reanalyze retained inputs and save child</button>{" "}
        <Link to={`/analyze?project=${projectId}&reanalyze=${runId}`} state={{ input: originalTemplateInput === null ? undefined : { template: originalTemplateInput, ...originalSource } }}>Reupload for linked reanalysis</Link>
        {actionError && <p role="alert">{actionError}</p>}
        {report?.sourceAnalysis && <details><summary>Saved source evidence ({report.sourceAnalysis.status}, {report.sourceAnalysis.fileCount} files)</summary>
          <p>Static inferences, not effective IAM permissions. Missing evidence does not prove a permission is unused.</p>
          <ul>{report.sourceAnalysis.actions.map((evidence, index) => <li key={index}><code>{evidence.action}</code> — {evidence.lambdaFunctionId ?? "Unmapped function"} · {evidence.filePath}{evidence.useLocation ? `:${evidence.useLocation.line}` : ""} · {evidence.confidence} confidence · {evidence.evidence}
            {evidence.importChain && <p>Import chain: {evidence.importChain.join(" → ")}</p>}
            {evidence.limitations?.map(limit => <p key={limit}>{limit}</p>)}
          </li>)}</ul>
        </details>}
      </section>
      <ReportPage key={run.runId} savedRun={run} />
    </>
  );
}
