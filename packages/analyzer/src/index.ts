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
export { analyzeTemplate } from "./analyzeTemplate";
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
  type SourceCodeActionInference
} from "./sourceCodeAnalysis";
