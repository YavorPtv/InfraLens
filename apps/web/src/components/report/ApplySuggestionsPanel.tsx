import { canDownloadGeneratedTemplate } from "@infralens/shared";
import { TemplateValidationPanel } from "./TemplateValidationPanel";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ApplySuggestionsResult,
  TemplateFix,
  TemplatePathSegment
} from "@infralens/shared";
import { applySuggestions } from "../../api/applySuggestions";
import { downloadTextFile } from "../../downloadTextFile";
import { createApplyComparison } from "../../compareInput";
import type { SourceAnalysisInput } from "@infralens/shared";
import type { SavedRun } from "@infralens/shared";
import { historyClient, saveRequestKey } from "../../api/history";

interface ApplySuggestionsPanelProps {
  savedRun?: SavedRun;
  fixes: TemplateFix[];
  originalTemplateInput: string | null;
  originalSource?: SourceAnalysisInput;
}

export function ApplySuggestionsPanel({
  fixes,
  originalTemplateInput,
  originalSource,
  savedRun
}: ApplySuggestionsPanelProps) {
  const [selectedFixIds, setSelectedFixIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ApplySuggestionsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [retainSource, setRetainSource] = useState(false);
  const [templateOnly, setTemplateOnly] = useState(false);
  const navigate = useNavigate();
  const applicableFixes = fixes.filter((fix) => fix.applicability === "applicable");
  const manualFixes = fixes.filter((fix) => fix.applicability === "manual-review");
  const selectedFixes = applicableFixes.filter((fix) => selectedFixIds.has(fix.id));
  const allApplicableSelected = applicableFixes.length > 0 &&
    applicableFixes.every((fix) => selectedFixIds.has(fix.id));
  const generatedTemplate =
    result === null ? null : `${JSON.stringify(result.modifiedTemplate, null, 2)}\n`;

  const canDownload = result !== null && canDownloadGeneratedTemplate(result.validation);

  async function handleApply(): Promise<void> {
    if (isApplying || originalTemplateInput === null || selectedFixes.length === 0) {
      return;
    }

    setIsApplying(true);
    setResult(null);
    setIsCopied(false);
    setError(null);

    try {
      setResult(
        await applySuggestions({
          templateInput: originalTemplateInput,
          fixes: selectedFixes
        })
      );
    } catch (applyError) {
      setResult(null);
      setError(
        applyError instanceof Error
          ? applyError.message
          : "Applying selected suggestions failed."
      );
    } finally {
      setIsApplying(false);
    }
  }

  async function saveChild(): Promise<void> {
    if (!savedRun || isApplying) return;
    setIsApplying(true);
    setError(null);
    try {
      const selection = { parent: savedRun.runId, fixIds: selectedFixes.map(fix => fix.id), templateOnly };
      const idempotencyKey = await saveRequestKey(savedRun.projectId, { kind: "apply", ...selection }, retainSource);
      const child = await historyClient.apply(savedRun.projectId, savedRun.runId, {
        fixIds: selection.fixIds, templateOnly, retainSource, idempotencyKey
      });
      sessionStorage.removeItem(`infralens-save-${savedRun.projectId}`);
      navigate(`/projects/${savedRun.projectId}/runs/${child.run.runId}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Saving child run failed.");
    } finally {
      setIsApplying(false);
    }
  }

  function toggleFix(fixId: string): void {
    setSelectedFixIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (nextIds.has(fixId)) {
        nextIds.delete(fixId);
      } else {
        nextIds.add(fixId);
      }
      return nextIds;
    });
    setResult(null);
    setError(null);
  }

  function toggleAllFixes(): void {
    setSelectedFixIds(
      allApplicableSelected ? new Set() : new Set(applicableFixes.map((fix) => fix.id))
    );
    setResult(null);
    setError(null);
    setIsCopied(false);
  }

  async function copyGeneratedTemplate(): Promise<void> {
    if (generatedTemplate === null) {
      return;
    }

    await navigator.clipboard.writeText(generatedTemplate);
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 1600);
  }

  return (
    <section className="report-panel apply-suggestions-panel">
      <div className="section-heading apply-suggestions-heading">
        <div>
          <h2>Apply Suggestions</h2>
          <p className="muted-note">
            Select deterministic fixes to generate a new template. The original input remains
            unchanged.
          </p>
        </div>
        <div className="fix-selection-controls">
          <span className="apply-count">{applicableFixes.length} applicable</span>
          {applicableFixes.length > 0 ? (
            <button
              className="text-button"
              disabled={isApplying}
              onClick={toggleAllFixes}
              type="button"
            >
              {allApplicableSelected ? "Deselect all" : "Select all"}
            </button>
          ) : null}
        </div>
      </div>

      {fixes.length === 0 ? (
        <p className="empty-state">No structured template fixes are available for this report.</p>
      ) : (
        <div className="template-fix-list">
          {applicableFixes.map((fix) => (
            <TemplateFixRow
              checked={selectedFixIds.has(fix.id)}
              disabled={isApplying}
              fix={fix}
              key={fix.id}
              onToggle={() => toggleFix(fix.id)}
            />
          ))}

          {manualFixes.length > 0 ? (
            <details className="manual-fixes">
              <summary>{manualFixes.length} suggestions require manual review</summary>
              <div className="manual-fix-list">
                {manualFixes.map((fix) => (
                  <TemplateFixRow checked={false} fix={fix} key={fix.id} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}

      {originalTemplateInput === null && applicableFixes.length > 0 ? (
        <p className="source-review-warning">
          Re-run the analysis to make the original template available for safe patching.
        </p>
      ) : null}

      <div className="apply-suggestions-actions">
        <button
          className="primary-button"
          disabled={
            isApplying || selectedFixes.length === 0 || originalTemplateInput === null
          }
          onClick={() => void handleApply()}
          type="button"
        >
          {isApplying ? "Applying and validating..." : `Apply selected suggestions (${selectedFixes.length})`}
        </button>
        {savedRun && (
          <div>
            <p>Save selected fixes as a linked child. The server regenerates and validates the template; the original report stays available.</p>
            {!savedRun.sourceRetained && (
              <p><label>
                <input type="checkbox" checked={templateOnly} onChange={event => setTemplateOnly(event.target.checked)} />{" "}
                Apply with template-only analysis (source unavailable)
              </label></p>
            )}
            {savedRun.sourceRetained && (
              <p><label>
                <input type="checkbox" checked={retainSource} onChange={event => setRetainSource(event.target.checked)} />{" "}
                Retain source in child for 7 days
              </label></p>
            )}
            <button
              className="primary-button"
              type="button"
              disabled={isApplying || selectedFixes.length === 0 || originalTemplateInput === null || result === null || !canDownload || result.failedFixCount > 0}
              onClick={() => void saveChild()}
            >
              Save selected fixes as child run
            </button>
          </div>
        )}
      </div>

      {error !== null ? (
        <div className="error-message" role="alert">
          {error}
        </div>
      ) : null}

      {result !== null && generatedTemplate !== null ? (
        <section className="generated-template-review">
          <TemplateValidationPanel validation={result.originalValidation} />
          <TemplateValidationPanel title="Generated template validation" validation={result.validation} />
          <p
            className={!canDownload ? "error-message" : result.generatedTemplateStatus === "ready" ? undefined : "validation-warning"}
            role="status"
          >
            {!canDownload
              ? "Validation failed — download blocked. Inspect the generated JSON below."
              : result.generatedTemplateStatus === "ready"
                ? "Validation passed — ready for review and download."
                : "Local validation passed — review required; AWS validation was not performed."}
          </p>
          <div className="generated-template-summary" role="status">
            <strong>{result.appliedFixCount} fixes applied</strong>
            <span>{result.failedFixCount} could not be applied</span>
          </div>

          {result.failedFixCount > 0 ? (
            <ul className="apply-failure-list">
              {result.results
                .filter((fixResult) => fixResult.status === "failed")
                .map((fixResult) => (
                  <li key={fixResult.fixId}>
                    <strong>{getFixTitle(fixes, fixResult.fixId)}</strong>
                    <span>{fixResult.message}</span>
                  </li>
                ))}
            </ul>
          ) : null}

          <div className="generated-template-toolbar">
            <div>
              <h3>Generated Template</h3>
              <p className="muted-note">Generated as CloudFormation JSON for review.</p>
            </div>
            <div className="report-export-actions">
              <button
                className="secondary-button"
                onClick={() => void copyGeneratedTemplate()}
                type="button"
              >
                {isCopied ? "Copied" : "Copy JSON"}
              </button>
              <button
                className="secondary-button"
                disabled={!canDownload}
                onClick={() =>
                  canDownload && downloadTextFile({
                    contents: generatedTemplate,
                    fileName: "infralens-improved-template.json",
                    mimeType: "application/json"
                  })
                }
                type="button"
              >
                Download improved template
              </button>
              <button
                className="secondary-button"
                disabled={originalTemplateInput === null || !canDownload}
                onClick={() =>
                  navigate("/compare", {
                    state: createApplyComparison(originalTemplateInput!, generatedTemplate!, originalSource)
                  })
                }
                type="button"
              >
                Compare with original
              </button>
            </div>
          </div>

          <pre className="generated-template-code">
            <code>{generatedTemplate}</code>
          </pre>
        </section>
      ) : null}
    </section>
  );
}

function TemplateFixRow({
  checked,
  disabled = false,
  fix,
  onToggle
}: {
  checked: boolean;
  disabled?: boolean;
  fix: TemplateFix;
  onToggle?: () => void;
}) {
  const isApplicable = fix.applicability === "applicable";

  return (
    <label className={`template-fix-row ${isApplicable ? "" : "template-fix-manual"}`}>
      <input
        checked={checked}
        disabled={disabled || !isApplicable}
        onChange={onToggle}
        type="checkbox"
      />
      <span className="template-fix-content">
        <span className="template-fix-title-row">
          <strong>{fix.title}</strong>
          <span className={`confidence-pill confidence-${fix.confidence}`}>
            {fix.confidence} confidence
          </span>
          <span className={`fix-kind-pill ${isApplicable ? "fix-kind-applicable" : "fix-kind-manual"}`}>
            {isApplicable ? "Applicable" : "Manual review"}
          </span>
        </span>
        <span>{fix.explanation}</span>
        <span className="template-fix-evidence">
          {fix.targetResourceId} | {formatSource(fix)}
        </span>
        {fix.patches.length > 0 ? (
          <span className="template-fix-paths">
            {fix.patches.map((patch) => formatPath(patch.path)).join(", ")}
          </span>
        ) : null}
      </span>
    </label>
  );
}

function formatSource(fix: TemplateFix): string {
  return fix.source.kind === "finding"
    ? `${fix.source.ruleId} | ${fix.source.evidencePath}`
    : `Lambda ${fix.source.lambdaFunctionId} | ${fix.source.evidencePath}`;
}

function formatPath(path: TemplatePathSegment[]): string {
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : segment))
    .join(".")
    .replace(/\.\[/g, "[");
}

function getFixTitle(fixes: TemplateFix[], fixId: string): string {
  return fixes.find((fix) => fix.id === fixId)?.title ?? fixId;
}
