import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ApplySuggestionsResult,
  TemplateFix,
  TemplatePathSegment
} from "@infralens/shared";
import { applySuggestions } from "../../api/applySuggestions";
import { downloadTextFile } from "../../downloadTextFile";

interface ApplySuggestionsPanelProps {
  fixes: TemplateFix[];
  originalTemplateInput: string | null;
}

export function ApplySuggestionsPanel({
  fixes,
  originalTemplateInput
}: ApplySuggestionsPanelProps) {
  const [selectedFixIds, setSelectedFixIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ApplySuggestionsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const navigate = useNavigate();
  const applicableFixes = fixes.filter((fix) => fix.applicability === "applicable");
  const manualFixes = fixes.filter((fix) => fix.applicability === "manual-review");
  const selectedFixes = useMemo(
    () => fixes.filter((fix) => fix.applicability === "applicable" && selectedFixIds.has(fix.id)),
    [fixes, selectedFixIds]
  );
  const allApplicableSelected = applicableFixes.length > 0 &&
    applicableFixes.every((fix) => selectedFixIds.has(fix.id));
  const generatedTemplate =
    result === null ? null : `${JSON.stringify(result.modifiedTemplate, null, 2)}\n`;

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
          {isApplying ? "Applying..." : `Apply selected suggestions (${selectedFixes.length})`}
        </button>
      </div>

      {error !== null ? (
        <div className="error-message" role="alert">
          {error}
        </div>
      ) : null}

      {result !== null && generatedTemplate !== null ? (
        <section className="generated-template-review">
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
              <h3>Improved Template</h3>
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
                onClick={() =>
                  downloadTextFile({
                    contents: generatedTemplate,
                    fileName: "infralens-improved-template.json",
                    mimeType: "application/json"
                  })
                }
                type="button"
              >
                Download JSON
              </button>
              <button
                className="secondary-button"
                disabled={originalTemplateInput === null}
                onClick={() =>
                  navigate("/compare", {
                    state: {
                      oldTemplateInput: originalTemplateInput,
                      newTemplateInput: generatedTemplate,
                      compareImmediately: true
                    }
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
