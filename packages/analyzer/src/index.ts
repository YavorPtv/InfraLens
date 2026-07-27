export interface AnalyzerPackage {
  name: string;
}

export const analyzerPackage: AnalyzerPackage = {
  name: "@infralens/analyzer"
};

export {
  createAnalysisContext,
  type AnalyzerAnalysisContext,
  type AnalysisContextHelpers,
  type CreateAnalysisContextInput
} from "./analysisContext";
export { analyzeTemplate, type AnalyzeTemplateOptions } from "./analyzeTemplate";
export {
  extractCloudFormationReferences,
  referencesToArchitectureEdges,
  type CloudFormationReference
} from "./extractReferences";
export {
  findLambdaExecutionRole,
  findPolicyResourcesAttachedToRole,
  findRoleInlinePolicies,
  type AttachedPolicyResourceLookup,
  type InlineRolePolicyLookup,
  type LambdaRoleLookup
} from "./iamPolicyLookup";
export {
  generateLeastPrivilegeResourceSuggestions,
  type GenerateLeastPrivilegeResourceSuggestionsOptions
} from "./leastPrivilegeSuggestions";
export { applyContextualSeverityAdjustments } from "./contextualSeverity";
export { parseTemplate, parseTemplateInput, templateToResourceNodes } from "./parseTemplate";
export { detectPublicEntryPoints } from "./publicEntryPoints";
export { findPubliclyReachableResources } from "./publicReachability";
export { buildRuntimeArchitectureGraph } from "./runtimeGraph";
export {
  inferIamActionsFromSourceCode,
  type InferIamActionsFromSourceCodeOptions,
  type SourceCodeActionInference,
  type SourceCodeActionInferenceConfidence,
  type SourceFileLambdaMapping
} from "./sourceCodeAnalysis";
export {
  analyzeTemplateDiff,
  type AnalyzeTemplateDiffOptions
} from "./templateDiff";
