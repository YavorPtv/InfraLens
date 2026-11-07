import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { SavedRun } from "@infralens/shared";
import { historyClient, saveRequestKey } from "../api/history";
import { analysisPollDelay, restoreSavedReport } from "../api/historyClient";
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll = 0;
    setRun(null);
    setError(null);
    setActionError(null);
    setTemplateOnly(false);
    setRetainSource(false);
    setReport(null);
    setOriginalTemplateInput(null);
    setOriginalSource(undefined);
    async function load(): Promise<void> {
      const status = await historyClient.status(projectId, runId);
      if (!active) return;
      if (status.job && status.job.status !== "SUCCEEDED") {
        setRun(status);
        if (status.job.status !== "FAILED") {
          timer = setTimeout(() => { void load().catch(handleError); }, analysisPollDelay(poll++));
        }
        return;
      }
      const result = await restoreSavedReport(historyClient, projectId, runId, {
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
      });
      if (active) setRun(result.run);
    }
    function handleError(error: Error) { if (active) setError(error.message); }
    void load().catch(handleError);
    return () => {
      active = false;
      clearTimeout(timer);
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
        <button className="secondary-button" onClick={() => window.location.reload()}>Retry loading</button>{" "}
        <Link to="/projects">Saved projects</Link>
      </section>
    );
  }
  if (!run || run.runId !== runId) {
    return <p role="status">Loading saved report…</p>;
  }
  if (run.job && run.job.status !== "SUCCEEDED") {
    return <section className="page-section">
      <Link to={`/projects/${projectId}`}>Back to history</Link>
      <h2>Saved analysis job</h2>
      <p role="status">{run.job.status.replaceAll("_", " ")} · {run.job.attempts} worker attempts</p>
      {run.job.status === "FAILED" ? <>
        <p role="alert">Analysis failed: {run.job.failure?.replaceAll("_", " ") ?? "Unknown failure"}.</p>
        <Link to={`/analyze?project=${projectId}&retry=${runId}`}>Reupload inputs and retry as a linked new run</Link>
      </> : <p>This job is saved. You can leave or refresh and return from project history. Status checks slow down to every 30 seconds while waiting.</p>}
    </section>;
  }
  return (
    <>
      <section className="page-section">
        <Link to={`/projects/${projectId}`}>Back to history</Link>
        <p>Stored report from {new Date(run.createdAt).toLocaleString()}. Opening it does not run the analyzer again.</p>
        {run.provenance && <p>{run.provenance.kind === "apply" ? "Applied fixes" : run.provenance.kind === "retry" ? "Retried analysis" : "Explicit reanalysis"} · {run.provenance.inputMode} inputs · <Link to={`/projects/${projectId}/runs/${run.provenance.parentRun.runId}`}>Original run</Link></p>}
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
