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
export { parseTemplate } from "./parseTemplate";
export { detectPublicEntryPoints } from "./publicEntryPoints";
export { buildRuntimeArchitectureGraph } from "./runtimeGraph";
