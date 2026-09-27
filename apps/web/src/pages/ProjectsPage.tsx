import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  exportDiffReportToMarkdown,
  type HistoryPage,
  type SavedProject,
  type SavedRun
} from "@infralens/shared";
import { historyClient } from "../api/history";

export function ProjectsPage() {
  const { projectId } = useParams();
  const [projects, setProjects] = useState<HistoryPage<SavedProject>>({ items: [] });
  const [runs, setRuns] = useState<HistoryPage<SavedRun>>({ items: [] });
  const [projectName, setProjectName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [comparisonMarkdown, setComparisonMarkdown] = useState("");

  useEffect(() => {
    let active = true;

    setIsBusy(true);
    setError(null);
    setSelectedRunIds([]);
    setComparisonMarkdown("");
    setRuns({ items: [] });

    async function loadPage(): Promise<void> {
      try {
        if (projectId) {
          const runPage = await historyClient.runs(projectId);
          if (active) {
            setRuns(runPage);
          }
        } else {
          const projectPage = await historyClient.projects();
          if (active) {
            setProjects(projectPage);
          }
        }
      } catch (loadError) {
        if (active) {
          setError((loadError as Error).message);
        }
      } finally {
        if (active) {
          setIsBusy(false);
        }
      }
    }

    void loadPage();

    return () => {
      active = false;
    };
  }, [projectId]);

  async function runAction(action: () => Promise<void>): Promise<void> {
    setIsBusy(true);
    setError(null);

    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Request failed.");
    } finally {
      setIsBusy(false);
    }
  }

  function showDeletionNotice(cleanupPending: boolean): void {
    if (cleanupPending) {
      setNotice(
        "Access removed. Physical cleanup is pending; use Retry cleanup after two minutes."
      );
    } else {
      setNotice("Deleted. Artifacts removed.");
    }
  }

  async function handleCleanup(): Promise<void> {
    await runAction(async () => {
      let cursor: string | undefined;
      let cleanupPending = false;

      do {
        const page = await historyClient.cleanup(cursor);
        cleanupPending = cleanupPending || page.cleanupPending;
        cursor = page.nextCursor;
      } while (cursor);

      setNotice(
        cleanupPending ? "Cleanup is still pending. Retry in two minutes." : "Cleanup complete."
      );
    });
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    await runAction(async () => {
      await historyClient.create(projectName);
      setProjectName("");
      setProjects(await historyClient.projects());
    });
  }

  async function handleRenameProject(project: SavedProject): Promise<void> {
    const updatedName = window.prompt("Project name", project.name);
    if (updatedName === null) {
      return;
    }

    await runAction(async () => {
      await historyClient.rename(project.projectId, updatedName);
      setProjects(await historyClient.projects());
    });
  }

  async function handleDeleteProject(project: SavedProject): Promise<void> {
    const confirmed = window.confirm(`Delete ${project.name} and all its saved runs?`);
    if (!confirmed) {
      return;
    }

    await runAction(async () => {
      const result = await historyClient.deleteProject(project.projectId);
      showDeletionNotice(result.cleanupPending);
      setProjects(await historyClient.projects());
    });
  }

  async function handleLoadMoreProjects(): Promise<void> {
    await runAction(async () => {
      const nextPage = await historyClient.projects(projects.nextCursor);
      setProjects({
        ...nextPage,
        items: [...projects.items, ...nextPage.items]
      });
    });
  }

  function handleRunSelection(runId: string, selected: boolean): void {
    setSelectedRunIds((currentIds) => {
      if (selected) {
        return [...currentIds, runId];
      }

      return currentIds.filter((currentId) => currentId !== runId);
    });
  }

  async function handleCompareRuns(): Promise<void> {
    if (!projectId) {
      return;
    }

    await runAction(async () => {
      const oldRun = { projectId, runId: selectedRunIds[0] };
      const newRun = { projectId, runId: selectedRunIds[1] };
      const report = await historyClient.compare(oldRun, newRun);
      setComparisonMarkdown(exportDiffReportToMarkdown(report));
    });
  }

  async function handleDeleteRun(runId: string): Promise<void> {
    if (!projectId || !window.confirm("Delete this saved run and its artifacts?")) {
      return;
    }

    await runAction(async () => {
      const result = await historyClient.deleteRun(projectId, runId);
      showDeletionNotice(result.cleanupPending);
      setRuns(await historyClient.runs(projectId));
      setSelectedRunIds([]);
      setComparisonMarkdown("");
    });
  }

  async function handleLoadMoreRuns(): Promise<void> {
    if (!projectId) {
      return;
    }

    await runAction(async () => {
      const nextPage = await historyClient.runs(projectId, runs.nextCursor);
      setRuns({
        ...nextPage,
        items: [...runs.items, ...nextPage.items]
      });
    });
  }

  return (
    <section className="page-section">
      <h2>{projectId ? "Analysis history" : "Saved projects"}</h2>
      <p className="muted-note">
        Reports remain until deleted, subject to quotas. Templates expire after 7 days. Source
        retention is optional; reanalysis and comparison may require reupload.
      </p>

      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {isBusy && <p role="status">Loading…</p>}

      <button className="secondary-button" disabled={isBusy} onClick={handleCleanup}>
        Retry cleanup
      </button>

      {projectId ? (
        <>
          <p>
            <Link to="/projects">All projects</Link> ·{" "}
            <Link className="primary-button" to={`/analyze?project=${projectId}`}>
              Analyze and save
            </Link>
          </p>
          <p>Select two runs in old → new order to compare their retained templates.</p>
          <button
            className="secondary-button"
            disabled={isBusy || selectedRunIds.length !== 2}
            onClick={handleCompareRuns}
          >
            Compare selected runs
          </button>

          <ul className="source-file-list">
            {runs.items.map((run) => {
              const selected = selectedRunIds.includes(run.runId);
              const selectionLimitReached = !selected && selectedRunIds.length === 2;

              return (
                <li className="source-file-item" key={run.runId}>
                  <div>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={isBusy || selectionLimitReached}
                        onChange={(event) => handleRunSelection(run.runId, event.target.checked)}
                      />{" "}
                      Select
                    </label>{" "}
                    <Link to={`/projects/${projectId}/runs/${run.runId}`}>
                      {new Date(run.createdAt).toLocaleString()}
                    </Link>
                    <p className="muted-note">
                      Inputs expire {new Date(run.inputExpiresAt).toLocaleString()}. Source{" "}
                      {run.sourceRetained ? "retained" : "not retained"}. Retained input:{" "}
                      {run.retainedInputBytes.toLocaleString()} bytes.
                    </p>
                  </div>
                  <button
                    className="text-button"
                    disabled={isBusy}
                    onClick={() => handleDeleteRun(run.runId)}
                  >
                    Delete run
                  </button>
                </li>
              );
            })}
          </ul>

          {!isBusy && runs.items.length === 0 && <p>No completed runs on this page.</p>}
          {runs.nextCursor && (
            <button className="secondary-button" disabled={isBusy} onClick={handleLoadMoreRuns}>
              Load more runs
            </button>
          )}
          {comparisonMarkdown && (
            <pre className="template-input" style={{ whiteSpace: "pre-wrap" }}>
              {comparisonMarkdown}
            </pre>
          )}
        </>
      ) : (
        <>
          <form className="analyze-actions" onSubmit={handleCreateProject}>
            <label>
              Project name{" "}
              <input
                maxLength={120}
                required
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            <button className="primary-button" disabled={isBusy}>
              Create project
            </button>
          </form>

          <ul className="source-file-list">
            {projects.items.map((project) => (
              <li className="source-file-item" key={project.projectId}>
                <Link to={`/projects/${project.projectId}`}>{project.name}</Link>
                <div>
                  <button
                    className="text-button"
                    disabled={isBusy}
                    onClick={() => handleRenameProject(project)}
                  >
                    Rename
                  </button>{" "}
                  <button
                    className="text-button"
                    disabled={isBusy}
                    onClick={() => handleDeleteProject(project)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {!isBusy && projects.items.length === 0 && <p>No projects on this page.</p>}
          {projects.nextCursor && (
            <button className="secondary-button" disabled={isBusy} onClick={handleLoadMoreProjects}>
              Load more projects
            </button>
          )}
        </>
      )}
    </section>
  );
}
