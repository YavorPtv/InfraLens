export interface AnalyzerPackage {
  name: string;
}

export const analyzerPackage: AnalyzerPackage = {
  name: "@infralens/analyzer"
};

export { analyzeTemplate } from "./analyzeTemplate";
export { parseTemplate } from "./parseTemplate";
