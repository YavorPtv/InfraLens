import type {
  CfnResource,
  DiffReport,
  Finding,
  FindingDiffSummary,
  ResourceDiffSummary,
  ResourceNode,
  SourceAnalysisReport,
  SourceActionEvidence,
  PolicySuggestion,
  PolicySuggestionDiffSummary,
  SourceDiffSummary
} from "@infralens/shared";
import { analyzeTemplate, type AnalyzeTemplateOptions } from "./analyzeTemplate";
import { parseTemplateInput } from "./parseTemplate";

export interface AnalyzeTemplateDiffOptions {
  oldTemplate?: AnalyzeTemplateOptions;
  newTemplate?: AnalyzeTemplateOptions;
}

export function analyzeTemplateDiff(
  oldTemplateInput: string,
  newTemplateInput: string,
  options: AnalyzeTemplateDiffOptions = {}
): DiffReport {
  const oldTemplate = parseTemplateInput(oldTemplateInput);
  const newTemplate = parseTemplateInput(newTemplateInput);
  const oldReport = analyzeTemplate(oldTemplateInput, options.oldTemplate);
  const newReport = analyzeTemplate(newTemplateInput, options.newTemplate);
  const source = diffSource(oldReport.sourceAnalysis!, newReport.sourceAnalysis!);
  source.warnings.push(...(oldReport.iamAnalysis?.limitations ?? []).map(warning => `Old IAM: ${warning}`),
    ...(newReport.iamAnalysis?.limitations ?? []).map(warning => `New IAM: ${warning}`));

  return {
    oldReport,
    newReport,
    resources: diffResources({
      oldResources: oldTemplate.Resources,
      newResources: newTemplate.Resources,
      oldResourceNodes: oldReport.resources,
      newResourceNodes: newReport.resources
    }),
    findings: diffFindings(oldReport.findings, newReport.findings),
    source,
    suggestions: diffSuggestions(oldReport.leastPrivilegeSuggestions, newReport.leastPrivilegeSuggestions)
  };
}

function diffSource(old: SourceAnalysisReport, next: SourceAnalysisReport): SourceDiffSummary {
  const key = (action: SourceActionEvidence) =>
    JSON.stringify([action.lambdaFunctionId ?? null, action.action, action.filePath, action.rootFilePath ?? null]);
  const oldActions = new Map(old.actions.map(action => [key(action), action]));
  const newActions = new Map(next.actions.map(action => [key(action), action]));
  const shared = next.actions.filter(action => oldActions.has(key(action)));
  return {
    old, new: next,
    added: next.actions.filter(action => !oldActions.has(key(action))),
    noLongerObserved: old.actions.filter(action => !newActions.has(key(action))),
    changed: shared.filter(action => stableStringify(oldActions.get(key(action))) !== stableStringify(action))
      .map(action => ({ old: oldActions.get(key(action))!, new: action })),
    unchanged: shared.filter(action => stableStringify(oldActions.get(key(action))) === stableStringify(action)),
    warnings: [
      "Source actions are static inferences, not actual IAM permissions. Actions no longer observed are not proof that permissions are unused or risk is resolved.",
      ...(old.status === "missing" || next.status === "missing"
        ? ["Source is missing on one or both sides. This comparison cannot establish source equivalence; reupload source for a source-aware comparison."] : []),
      ...old.warnings.map(warning => `Old: ${warning}`),
      ...next.warnings.map(warning => `New: ${warning}`),
      ...(old.actions.some(action => !action.lambdaFunctionId) || next.actions.some(action => !action.lambdaFunctionId)
        ? ["Some inferred actions have no resolved Lambda mapping; attribution requires manual review."] : [])
    ]
  };
}

function diffSuggestions(old: PolicySuggestion[], next: PolicySuggestion[]): PolicySuggestionDiffSummary {
  const key = (suggestion: PolicySuggestion) => JSON.stringify([
    suggestion.lambdaFunctionId, suggestion.roleId, suggestion.service, suggestion.evidence.statementEvidencePath
  ]);
  const oldByKey = new Map(old.map(suggestion => [key(suggestion), suggestion]));
  const nextByKey = new Map(next.map(suggestion => [key(suggestion), suggestion]));
  const shared = next.filter(suggestion => oldByKey.has(key(suggestion)));
  return {
    added: next.filter(suggestion => !oldByKey.has(key(suggestion))),
    removed: old.filter(suggestion => !nextByKey.has(key(suggestion))),
    changed: shared.filter(suggestion => suggestionSignature(oldByKey.get(key(suggestion))!) !== suggestionSignature(suggestion))
      .map(suggestion => ({ old: oldByKey.get(key(suggestion))!, new: suggestion })),
    unchanged: shared.filter(suggestion => suggestionSignature(oldByKey.get(key(suggestion))!) === suggestionSignature(suggestion))
  };
}

function suggestionSignature(suggestion: PolicySuggestion): string {
  return stableStringify({ ...suggestion,
    currentActions: [...suggestion.currentActions].sort(),
    suggestedActions: [...suggestion.suggestedActions].sort(),
    actions: [...suggestion.actions].sort()
  });
}

function diffResources({
  oldResources,
  newResources,
  oldResourceNodes,
  newResourceNodes
}: {
  oldResources: Record<string, CfnResource>;
  newResources: Record<string, CfnResource>;
  oldResourceNodes: ResourceNode[];
  newResourceNodes: ResourceNode[];
}): ResourceDiffSummary {
  const oldNodesById = mapResourceNodesById(oldResourceNodes);
  const newNodesById = mapResourceNodesById(newResourceNodes);
  const oldResourceIds = new Set(Object.keys(oldResources));
  const newResourceIds = new Set(Object.keys(newResources));

  const added = newResourceNodes.filter((resource) => !oldResourceIds.has(resource.id));
  const removed = oldResourceNodes.filter((resource) => !newResourceIds.has(resource.id));
  const changed = Object.keys(newResources).flatMap((resourceId) => {
    const oldResource = oldResources[resourceId];
    const newResource = newResources[resourceId];
    const oldResourceNode = oldNodesById.get(resourceId);
    const newResourceNode = newNodesById.get(resourceId);

    if (
      oldResource === undefined ||
      oldResourceNode === undefined ||
      newResourceNode === undefined ||
      stableStringify(oldResource) === stableStringify(newResource)
    ) {
      return [];
    }

    return [
      {
        resourceId,
        oldResource: oldResourceNode,
        newResource: newResourceNode
      }
    ];
  });

  return {
    added,
    removed,
    changed
  };
}

function mapResourceNodesById(resources: ResourceNode[]): Map<string, ResourceNode> {
  return new Map(resources.map((resource) => [resource.id, resource]));
}

function diffFindings(oldFindings: Finding[], newFindings: Finding[]): FindingDiffSummary {
  const oldFindingsByKey = mapFindingsByKey(oldFindings);
  const newFindingsByKey = mapFindingsByKey(newFindings);

  return {
    introduced: newFindings.filter((finding) => !oldFindingsByKey.has(getFindingKey(finding))),
    resolved: oldFindings.filter((finding) => !newFindingsByKey.has(getFindingKey(finding))),
    unchanged: newFindings.filter((finding) => oldFindingsByKey.has(getFindingKey(finding)))
  };
}

function mapFindingsByKey(findings: Finding[]): Map<string, Finding> {
  return new Map(findings.map((finding) => [getFindingKey(finding), finding]));
}

function getFindingKey(finding: Finding): string {
  return [
    finding.ruleId,
    finding.resourceId,
    finding.evidencePath
  ].join("\0");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, childValue]) => [key, sortObjectKeys(childValue)])
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
