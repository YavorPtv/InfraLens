import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SavedRun } from "@infralens/shared";
import { historyClient } from "../api/history";
import { restoreSavedReport } from "../api/historyClient";
import { useAnalysisReport } from "../reportState";
import { ReportPage } from "./ReportPage";

export function SavedReportPage() {
  const { projectId = "", runId = "" } = useParams();
  const { setReport, setOriginalTemplateInput } = useAnalysisReport();
  const [run, setRun] = useState<SavedRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setRun(null);
    setError(null);
    setReport(null);
    setOriginalTemplateInput(null);
    void restoreSavedReport(historyClient, projectId, runId, {
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
  }, [projectId, runId, setReport, setOriginalTemplateInput]);
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
        <p className="muted-note">
          Inputs expire {new Date(run.inputExpiresAt).toLocaleString()}. Source{" "}
          {run.sourceRetained ? "retained" : "not retained"}.
          {Date.parse(run.inputExpiresAt) <= Date.now() &&
            " Inputs have expired. Reupload to reanalyze, apply fixes or compare."}
        </p>
      </section>
      <ReportPage />
    </>
  );
}
