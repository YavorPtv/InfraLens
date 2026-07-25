import type {
  CfnResource,
  DiffReport,
  Finding,
  FindingDiffSummary,
  ResourceDiffSummary,
  ResourceNode
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

  return {
    oldReport,
    newReport,
    resources: diffResources({
      oldResources: oldTemplate.Resources,
      newResources: newTemplate.Resources,
      oldResourceNodes: oldReport.resources,
      newResourceNodes: newReport.resources
    }),
    findings: diffFindings(oldReport.findings, newReport.findings)
  };
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
