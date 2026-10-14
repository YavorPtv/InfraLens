import { createContext, useContext, useState, type PropsWithChildren } from "react";
import type { AnalysisReport, SourceAnalysisInput } from "@infralens/shared";

interface AnalysisReportState {
  report: AnalysisReport | null;
  originalTemplateInput: string | null;
  originalSource: SourceAnalysisInput | undefined;
  setOriginalSource: (source: SourceAnalysisInput | undefined) => void;
  setReport: (report: AnalysisReport | null) => void;
  setOriginalTemplateInput: (templateInput: string | null) => void;
}

const AnalysisReportContext = createContext<AnalysisReportState | null>(null);

export function AnalysisReportProvider({ children }: PropsWithChildren) {
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [originalTemplateInput, setOriginalTemplateInput] = useState<string | null>(null);
  const [originalSource, setOriginalSource] = useState<SourceAnalysisInput | undefined>();

  return (
    <AnalysisReportContext.Provider
      value={{ report, originalTemplateInput, originalSource, setOriginalSource, setReport, setOriginalTemplateInput }}
    >
      {children}
    </AnalysisReportContext.Provider>
  );
}

export function useAnalysisReport(): AnalysisReportState {
  const context = useContext(AnalysisReportContext);

  if (context === null) {
    throw new Error("useAnalysisReport must be used inside AnalysisReportProvider.");
  }

  return context;
}
