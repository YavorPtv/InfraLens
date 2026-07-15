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
export { applyContextualSeverityAdjustments } from "./contextualSeverity";
export { parseTemplate } from "./parseTemplate";
export { detectPublicEntryPoints } from "./publicEntryPoints";
export { findPubliclyReachableResources } from "./publicReachability";
export { buildRuntimeArchitectureGraph } from "./runtimeGraph";
