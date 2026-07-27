import { useState } from "react";
import type {
  CfnValue,
  PolicySuggestion,
  PolicySuggestionResourceCandidate,
  PolicySuggestionSourceActionEvidence
} from "@infralens/shared";

interface LeastPrivilegeSuggestionsProps {
  suggestions: PolicySuggestion[];
}

interface PolicyStatementPreview {
  Effect: "Allow";
  Action: string | string[];
  Resource: CfnValue | CfnValue[];
}

export function LeastPrivilegeSuggestions({ suggestions }: LeastPrivilegeSuggestionsProps) {
  const [copiedSuggestionKey, setCopiedSuggestionKey] = useState<string | null>(null);

  async function handleCopySuggestedPolicy(
    suggestion: PolicySuggestion,
    suggestionKey: string
  ): Promise<void> {
    await navigator.clipboard.writeText(formatJson(createSuggestedPolicyStatement(suggestion)));
    setCopiedSuggestionKey(suggestionKey);
    window.setTimeout(() => setCopiedSuggestionKey(null), 1600);
  }

  return (
    <section className="report-panel policy-suggestions-panel">
      <div className="section-heading">
        <h2>Least-Privilege Suggestions</h2>
        <p className="muted-note">
          Template-only IAM resource narrowing suggestions based on Lambda resource references.
        </p>
      </div>

      {suggestions.length === 0 ? (
        <p className="empty-state">No least-privilege policy suggestions were generated.</p>
      ) : (
        <div className="policy-suggestion-list">
          {suggestions.map((suggestion) => {
            const suggestionKey = getSuggestionKey(suggestion);
            const originalStatement = createOriginalPolicyStatement(suggestion);
            const suggestedStatement = createSuggestedPolicyStatement(suggestion);

            return (
              <article className="policy-suggestion-card" key={suggestionKey}>
                <div className="policy-suggestion-header">
                  <div>
                    <span className={`confidence-pill confidence-${suggestion.confidence}`}>
                      Confidence: {formatConfidence(suggestion.confidence)}
                    </span>
                    <h3>{suggestion.roleId}</h3>
                    <p className="muted-note">
                      {formatPolicySource(suggestion)}
                      {suggestion.lambdaFunctionId.length > 0
                        ? ` for Lambda ${suggestion.lambdaFunctionId}`
                        : ""}
                    </p>
                  </div>
                  <button
                    className="secondary-button copy-policy-button"
                    onClick={() => {
                      void handleCopySuggestedPolicy(suggestion, suggestionKey);
                    }}
                    type="button"
                  >
                    {copiedSuggestionKey === suggestionKey ? "Copied" : "Copy JSON"}
                  </button>
                </div>

                <p>{suggestion.explanation}</p>

                <SourceInferenceEvidence suggestion={suggestion} />

                <dl className="policy-suggestion-meta">
                  <div>
                    <dt>Affected Role</dt>
                    <dd>{suggestion.roleId}</dd>
                  </div>
                  <div>
                    <dt>Related Lambda</dt>
                    <dd>{suggestion.lambdaFunctionId}</dd>
                  </div>
                  <div>
                    <dt>Service</dt>
                    <dd>{suggestion.service}</dd>
                  </div>
                  <div>
                    <dt>Current Actions</dt>
                    <dd>{getCurrentActions(suggestion).join(", ")}</dd>
                  </div>
                  <div>
                    <dt>Suggested Actions</dt>
                    <dd>{getSuggestedActions(suggestion).join(", ")}</dd>
                  </div>
                </dl>

                <div className="policy-diff-grid" aria-label="Original and suggested policy statements">
                  <PolicyJsonBlock
                    code={formatJson(originalStatement)}
                    label="Original statement"
                    tone="original"
                  />
                  <PolicyJsonBlock
                    code={formatJson(suggestedStatement)}
                    label="Suggested replacement"
                    tone="suggested"
                  />
                </div>

                <div className="policy-evidence-grid">
                  <EvidenceBlock
                    items={[
                      ["Lambda role", suggestion.evidence.lambdaRoleEvidencePath],
                      ["Policy", suggestion.evidence.policyEvidencePath],
                      ["Statement", suggestion.evidence.statementEvidencePath]
                    ]}
                    title="Evidence"
                  />
                  <SuggestedResources resources={suggestion.suggestedResources} />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PolicyJsonBlock({
  code,
  label,
  tone
}: {
  code: string;
  label: string;
  tone: "original" | "suggested";
}) {
  return (
    <div className={`policy-json-block policy-json-${tone}`}>
      <div className="policy-json-label">{label}</div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function EvidenceBlock({ items, title }: { items: Array<[string, string]>; title: string }) {
  return (
    <div className="policy-evidence-block">
      <h4>{title}</h4>
      <dl>
        {items.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SuggestedResources({ resources }: { resources: PolicySuggestionResourceCandidate[] }) {
  if (resources.length === 0) {
    return (
      <div className="policy-evidence-block">
        <h4>Inferred Resources</h4>
        <p className="muted-note">No safe resource replacement was inferred.</p>
      </div>
    );
  }

  return (
    <div className="policy-evidence-block">
      <h4>Inferred Resources</h4>
      <dl className="inferred-resource-list">
        {resources.map((resource) => (
          <div key={`${resource.resourceId}-${resource.referenceEvidencePath}`}>
            <dt>{resource.resourceId}</dt>
            <dd>
              {resource.resourceType}
              <span>{resource.referenceEvidencePath}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SourceInferenceEvidence({ suggestion }: { suggestion: PolicySuggestion }) {
  const sourceActions = suggestion.evidence.sourceActions ?? [];

  if (sourceActions.length === 0) {
    return (
      <section className="source-inference-panel source-inference-template-only">
        <div className="source-inference-heading">
          <h4>Source Inference</h4>
          <span className="source-kind-pill source-kind-template">Template-only</span>
        </div>
        <p>
          This suggestion did not use source-code action inference. Resource narrowing is based on
          CloudFormation references only.
        </p>
      </section>
    );
  }

  const hasUncertainMapping = sourceActions.some((action) => action.confidence !== "high");

  return (
    <section
      className={
        hasUncertainMapping
          ? "source-inference-panel source-inference-review"
          : "source-inference-panel"
      }
    >
      <div className="source-inference-heading">
        <div>
          <h4>Source Inference</h4>
          <p>
            Policy suggestion confidence and source-file mapping confidence are related signals,
            but they are not the same thing.
          </p>
        </div>
        <span className="source-kind-pill source-kind-source">Source-based</span>
      </div>

      {hasUncertainMapping ? (
        <p className="source-review-warning">
          Review source-file mapping before applying action narrowing.
        </p>
      ) : null}

      <ul className="source-action-list">
        {sourceActions.map((action) => (
          <li key={`${action.filePath}-${action.action}-${action.matchedCommand}`}>
            <div className="source-action-summary">
              <strong>
                Detected {action.matchedCommand} in {action.filePath}
                {" -> "}
                {action.action}
              </strong>
              <span
                className={`source-mapping-pill source-mapping-${getMappingConfidence(action)}`}
              >
                {formatConfidence(getMappingConfidence(action))} mapping
              </span>
            </div>

            <dl className="source-action-evidence">
              <EvidenceItem label="Lambda logical ID" value={getMappedLambda(action)} />
              <EvidenceItem label="Source file path" value={action.filePath} />
              <EvidenceItem label="Detected SDK command" value={action.matchedCommand} />
              <EvidenceItem label="Inferred IAM action" value={action.action} />
              <EvidenceItem label="SDK command confidence" value="High" />
              <EvidenceItem
                label="Mapping confidence"
                value={formatConfidence(getMappingConfidence(action))}
              />
              <EvidenceItem label="Mapping source" value={getMappingSourceLabel(action.evidence)} />
              <EvidenceItem label="Mapping evidence" value={formatMappingEvidence(action)} />
              <EvidenceItem
                label="Related CloudFormation resource"
                value={formatRelatedResources(suggestion.suggestedResources)}
              />
              <EvidenceItem
                label="Resource evidence"
                value={formatResourceEvidence(suggestion.suggestedResources)}
              />
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EvidenceItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function createOriginalPolicyStatement(suggestion: PolicySuggestion): PolicyStatementPreview {
  return {
    Effect: "Allow",
    Action: formatActions(getCurrentActions(suggestion)),
    Resource: suggestion.currentResource
  };
}

function createSuggestedPolicyStatement(suggestion: PolicySuggestion): PolicyStatementPreview {
  return {
    Effect: "Allow",
    Action: formatActions(getSuggestedActions(suggestion)),
    Resource: formatSuggestedResource(suggestion)
  };
}

function formatActions(actions: string[]): string | string[] {
  return actions.length === 1 ? actions[0] : actions;
}

function getCurrentActions(suggestion: PolicySuggestion): string[] {
  return getRuntimeActions(suggestion, "currentActions") ?? suggestion.actions ?? [];
}

function getSuggestedActions(suggestion: PolicySuggestion): string[] {
  return getRuntimeActions(suggestion, "suggestedActions") ?? suggestion.actions ?? [];
}

function getRuntimeActions(
  suggestion: PolicySuggestion,
  property: "currentActions" | "suggestedActions"
): string[] | undefined {
  const value = (suggestion as Partial<PolicySuggestion>)[property];

  return Array.isArray(value) ? value : undefined;
}

function formatSuggestedResource(suggestion: PolicySuggestion): CfnValue | CfnValue[] {
  if (suggestion.suggestedResources.length === 0) {
    return suggestion.currentResource;
  }

  if (suggestion.suggestedResources.length === 1) {
    return suggestion.suggestedResources[0].suggestedResource;
  }

  return suggestion.suggestedResources.map((resource) => resource.suggestedResource);
}

function formatPolicySource(suggestion: PolicySuggestion): string {
  const policyName = suggestion.policyName ?? suggestion.policyResourceId ?? "Unnamed policy";
  const source =
    suggestion.policySourceType === "inline-role-policy"
      ? "inline role policy"
      : "attached policy resource";

  return `${policyName} (${source})`;
}

function getMappedLambda(action: PolicySuggestionSourceActionEvidence): string {
  return action.lambdaFunctionId.length > 0 ? action.lambdaFunctionId : "Unknown";
}

function getMappingConfidence(
  action: PolicySuggestionSourceActionEvidence
): PolicySuggestionSourceActionEvidence["confidence"] {
  return action.confidence;
}

function getMappingSourceLabel(evidence: string): string {
  if (evidence.startsWith("sourceFileMappings.")) {
    return "Explicit mapping";
  }

  if (evidence.includes(".Properties.Handler")) {
    return "Handler match";
  }

  if (evidence.includes(".Properties.Code.")) {
    return "Code path match";
  }

  if (evidence.includes(".Metadata.")) {
    return "Metadata match";
  }

  if (evidence.startsWith("source file name matched")) {
    return "File-name match";
  }

  if (evidence === "single Lambda function in template") {
    return "Fallback inference";
  }

  return "Inference evidence";
}

function formatMappingEvidence(action: PolicySuggestionSourceActionEvidence): string {
  const mappingSource = getMappingSourceLabel(action.evidence);

  if (mappingSource === "Handler match") {
    return `Mapped ${action.filePath} to ${action.lambdaFunctionId} from ${action.evidence}.`;
  }

  if (mappingSource === "Explicit mapping") {
    return `${action.filePath} mapped to ${action.lambdaFunctionId} by explicit request input.`;
  }

  if (mappingSource === "File-name match") {
    return `${action.filePath} mapped to ${action.lambdaFunctionId} from file-name matching.`;
  }

  if (mappingSource === "Fallback inference") {
    return `${action.filePath} mapped to ${action.lambdaFunctionId} because the template has one Lambda.`;
  }

  return `${action.filePath} mapped to ${action.lambdaFunctionId} using ${action.evidence}.`;
}

function formatRelatedResources(resources: PolicySuggestionResourceCandidate[]): string {
  if (resources.length === 0) {
    return "No related CloudFormation resource inferred.";
  }

  return resources.map((resource) => resource.resourceId).join(", ");
}

function formatResourceEvidence(resources: PolicySuggestionResourceCandidate[]): string {
  if (resources.length === 0) {
    return "No resource reference evidence.";
  }

  return resources
    .map((resource) => `${formatReferenceName(resource.referenceEvidencePath)} references ${resource.resourceId}`)
    .join("; ");
}

function formatReferenceName(evidencePath: string): string {
  const variableMatch = evidencePath.match(/\.Variables\.([^.[]+)/);

  return variableMatch?.[1] ?? evidencePath;
}

function formatConfidence(confidence: PolicySuggestion["confidence"]): string {
  return confidence.charAt(0).toUpperCase() + confidence.slice(1);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function getSuggestionKey(suggestion: PolicySuggestion): string {
  return [
    suggestion.roleId,
    suggestion.lambdaFunctionId,
    suggestion.policyName,
    suggestion.policyResourceId,
    suggestion.evidence.statementEvidencePath
  ]
    .filter(Boolean)
    .join("-");
}
