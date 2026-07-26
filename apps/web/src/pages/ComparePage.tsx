import { useRef, useState, type ChangeEvent, type RefObject } from "react";
import { exportDiffReportToMarkdown } from "@infralens/shared";
import type { ChangedResource, DiffReport, Finding, ResourceNode } from "@infralens/shared";
import { compareTemplates } from "../api/compareTemplates";
import { downloadTextFile } from "../downloadTextFile";

const acceptedTemplateExtensions = [".json", ".yaml", ".yml"];

type TemplateSide = "old" | "new";

export function ComparePage() {
  const [oldTemplateInput, setOldTemplateInput] = useState("");
  const [newTemplateInput, setNewTemplateInput] = useState("");
  const [diffReport, setDiffReport] = useState<DiffReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const oldFileInputRef = useRef<HTMLInputElement | null>(null);
  const newFileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
    side: TemplateSide
  ): Promise<void> {
    const file = event.target.files?.[0];

    if (file === undefined) {
      return;
    }

    if (!isAcceptedTemplateFile(file.name)) {
      setError("Choose .json, .yaml, or .yml CloudFormation template files.");
      event.target.value = "";
      return;
    }

    const templateText = await file.text();
    if (side === "old") {
      setOldTemplateInput(templateText);
    } else {
      setNewTemplateInput(templateText);
    }

    setError(null);
  }

  async function handleCompare(): Promise<void> {
    if (oldTemplateInput.trim().length === 0 || newTemplateInput.trim().length === 0) {
      setError("Paste or upload both the old and new CloudFormation templates first.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      setDiffReport(
        await compareTemplates({
          oldTemplateInput,
          newTemplateInput
        })
      );
    } catch (comparisonError) {
      setDiffReport(null);
      setError(
        comparisonError instanceof Error
          ? comparisonError.message
          : "Template comparison failed. Check both templates and try again."
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <section className="page-section compare-layout">
      <div className="section-heading">
        <h2>Compare Templates</h2>
        <p className="muted-note">
          Compare two CloudFormation templates to see resource changes and risk movement.
        </p>
      </div>

      <div className="compare-input-grid">
        <TemplateInputPanel
          fileInputRef={oldFileInputRef}
          id="old-template-input"
          label="Old Template"
          onChange={setOldTemplateInput}
          onFileChange={(event) => {
            void handleFileChange(event, "old");
          }}
          value={oldTemplateInput}
        />
        <TemplateInputPanel
          fileInputRef={newFileInputRef}
          id="new-template-input"
          label="New Template"
          onChange={setNewTemplateInput}
          onFileChange={(event) => {
            void handleFileChange(event, "new");
          }}
          value={newTemplateInput}
        />
      </div>

      <div className="analyze-actions">
        <button
          className="primary-button"
          disabled={isLoading}
          onClick={() => {
            void handleCompare();
          }}
          type="button"
        >
          {isLoading ? "Comparing..." : "Compare Templates"}
        </button>
      </div>

      {error !== null ? (
        <div className="error-message" role="alert">
          {error}
        </div>
      ) : null}

      {diffReport !== null ? <DiffReportView report={diffReport} /> : null}
    </section>
  );
}

function TemplateInputPanel({
  fileInputRef,
  id,
  label,
  onChange,
  onFileChange,
  value
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  id: string;
  label: string;
  onChange: (value: string) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  value: string;
}) {
  return (
    <div className="compare-input-panel">
      <div className="input-toolbar">
        <div>
          <label className="input-label" htmlFor={id}>
            {label}
          </label>
          <p className="muted-note">Paste JSON or YAML, or upload a local file.</p>
        </div>
        <div className="file-upload">
          <input
            accept=".json,.yaml,.yml,application/json,application/x-yaml,application/yaml,text/yaml"
            className="file-input"
            onChange={onFileChange}
            ref={fileInputRef}
            type="file"
          />
          <button
            className="secondary-button"
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            Upload
          </button>
        </div>
      </div>

      <textarea
        className="template-input compare-template-input"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder='Paste a template here, for example { "Resources": {} }'
        value={value}
      />
    </div>
  );
}

function DiffReportView({ report }: { report: DiffReport }) {
  return (
    <div className="diff-report">
      <div className="report-export-bar">
        <div>
          <h2>Diff Report</h2>
          <p className="muted-note">Download this comparison as a Markdown report.</p>
        </div>
        <div className="report-export-actions">
          <button
            className="secondary-button"
            onClick={() =>
              downloadTextFile({
                contents: exportDiffReportToMarkdown(report),
                fileName: "infralens-diff-report.md",
                mimeType: "text/markdown"
              })
            }
            type="button"
          >
            Download Markdown
          </button>
        </div>
      </div>
      <DiffSummary report={report} />

      <section className="diff-section">
        <h2>Resource Changes</h2>
        <div className="diff-grid">
          <ResourceList title="Added Resources" resources={report.resources.added} tone="added" />
          <ResourceList title="Removed Resources" resources={report.resources.removed} tone="removed" />
          <ChangedResourceList resources={report.resources.changed} />
        </div>
      </section>

      <section className="diff-section">
        <h2>Risk Changes</h2>
        <div className="diff-grid">
          <FindingList
            findings={report.findings.introduced}
            highlightSevere
            title="Newly Introduced Risks"
          />
          <FindingList findings={report.findings.resolved} title="Resolved Risks" />
          <FindingList findings={report.findings.unchanged} title="Unchanged Risks" />
        </div>
      </section>
    </div>
  );
}

function DiffSummary({ report }: { report: DiffReport }) {
  return (
    <div className="diff-summary-grid">
      <DiffMetric label="Added" value={report.resources.added.length} />
      <DiffMetric label="Removed" value={report.resources.removed.length} />
      <DiffMetric label="Changed" value={report.resources.changed.length} />
      <DiffMetric label="Introduced Risks" value={report.findings.introduced.length} />
      <DiffMetric label="Resolved Risks" value={report.findings.resolved.length} />
      <DiffMetric label="Unchanged Risks" value={report.findings.unchanged.length} />
    </div>
  );
}

function DiffMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ResourceList({
  resources,
  title,
  tone
}: {
  resources: ResourceNode[];
  title: string;
  tone: "added" | "removed";
}) {
  return (
    <div className="diff-panel">
      <h3>{title}</h3>
      {resources.length === 0 ? (
        <p className="empty-state">None.</p>
      ) : (
        <ul className="diff-list">
          {resources.map((resource) => (
            <li className={`resource-change resource-change-${tone}`} key={resource.id}>
              <strong>{resource.id}</strong>
              <span>{formatResourceType(resource.type)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChangedResourceList({ resources }: { resources: ChangedResource[] }) {
  return (
    <div className="diff-panel">
      <h3>Changed Resources</h3>
      {resources.length === 0 ? (
        <p className="empty-state">None.</p>
      ) : (
        <ul className="diff-list">
          {resources.map((resource) => (
            <li className="resource-change resource-change-changed" key={resource.resourceId}>
              <strong>{resource.resourceId}</strong>
              <span>
                {formatResourceType(resource.oldResource.type)}
                {" -> "}
                {formatResourceType(resource.newResource.type)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FindingList({
  findings,
  highlightSevere = false,
  title
}: {
  findings: Finding[];
  highlightSevere?: boolean;
  title: string;
}) {
  return (
    <div className="diff-panel">
      <h3>{title}</h3>
      {findings.length === 0 ? (
        <p className="empty-state">None.</p>
      ) : (
        <ul className="diff-list">
          {findings.map((finding) => {
            const isSevereIntroduction =
              highlightSevere &&
              (finding.severity === "critical" || finding.severity === "high");

            return (
              <li
                className={
                  isSevereIntroduction
                    ? "finding-change finding-change-severe"
                    : "finding-change"
                }
                key={`${finding.ruleId}-${finding.resourceId}-${finding.evidencePath}`}
              >
                <div className="finding-card-header">
                  <h4>{finding.title}</h4>
                  <span className={`severity-pill severity-${finding.severity}`}>
                    {finding.severity}
                  </span>
                </div>
                <p className="resource-id">{finding.resourceId}</p>
                <p>{finding.explanation}</p>
                <span>{finding.evidencePath}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatResourceType(type: string): string {
  return type.replace("AWS::", "");
}

function isAcceptedTemplateFile(fileName: string): boolean {
  const normalizedFileName = fileName.toLowerCase();

  return acceptedTemplateExtensions.some((extension) =>
    normalizedFileName.endsWith(extension)
  );
}
