import { createContext, useContext, useState, type PropsWithChildren } from "react";
import type { AnalysisReport } from "@infralens/shared";

interface AnalysisReportState {
  report: AnalysisReport | null;
  setReport: (report: AnalysisReport | null) => void;
}

const AnalysisReportContext = createContext<AnalysisReportState | null>(null);

export function AnalysisReportProvider({ children }: PropsWithChildren) {
  const [report, setReport] = useState<AnalysisReport | null>(null);

  return (
    <AnalysisReportContext.Provider value={{ report, setReport }}>
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
