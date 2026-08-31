import { createContext, useContext, useState, type PropsWithChildren } from "react";
import type { AnalysisReport } from "@infralens/shared";

interface AnalysisReportState {
  report: AnalysisReport | null;
  originalTemplateInput: string | null;
  setReport: (report: AnalysisReport | null) => void;
  setOriginalTemplateInput: (templateInput: string | null) => void;
}

const AnalysisReportContext = createContext<AnalysisReportState | null>(null);

export function AnalysisReportProvider({ children }: PropsWithChildren) {
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [originalTemplateInput, setOriginalTemplateInput] = useState<string | null>(null);

  return (
    <AnalysisReportContext.Provider
      value={{ report, originalTemplateInput, setReport, setOriginalTemplateInput }}
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
