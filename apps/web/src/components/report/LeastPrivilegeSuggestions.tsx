import { useState } from "react";
import type { CfnValue, PolicySuggestion, PolicySuggestionResourceCandidate } from "@infralens/shared";

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
                    <dt>Actions</dt>
                    <dd>{suggestion.actions.join(", ")}</dd>
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

function createOriginalPolicyStatement(suggestion: PolicySuggestion): PolicyStatementPreview {
  return {
    Effect: "Allow",
    Action: formatActions(suggestion.actions),
    Resource: suggestion.currentResource
  };
}

function createSuggestedPolicyStatement(suggestion: PolicySuggestion): PolicyStatementPreview {
  return {
    Effect: "Allow",
    Action: formatActions(suggestion.actions),
    Resource: formatSuggestedResource(suggestion)
  };
}

function formatActions(actions: string[]): string | string[] {
  return actions.length === 1 ? actions[0] : actions;
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
