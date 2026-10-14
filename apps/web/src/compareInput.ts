import { normalizeSourceAnalysisInput, type DiffApiRequest, type SourceAnalysisInput } from "@infralens/shared";

export interface CompareNavigationState {
  oldTemplateInput: string;
  newTemplateInput: string;
  oldSource?: SourceAnalysisInput;
  newSource?: SourceAnalysisInput;
  compareImmediately?: boolean;
}

export function serializeCompareRequest(input: CompareNavigationState): DiffApiRequest {
  return {
    oldTemplate: input.oldTemplateInput,
    newTemplate: input.newTemplateInput,
    ...(input.oldSource === undefined ? {} : { oldSource: normalizeSourceAnalysisInput(input.oldSource) }),
    ...(input.newSource === undefined ? {} : { newSource: normalizeSourceAnalysisInput(input.newSource) })
  };
}

export function createApplyComparison(oldTemplateInput: string, newTemplateInput: string,
  source?: SourceAnalysisInput): CompareNavigationState {
  return { oldTemplateInput, newTemplateInput, oldSource: source, newSource: source, compareImmediately: true };
}
