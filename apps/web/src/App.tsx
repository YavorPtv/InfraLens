import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { AnalyzePage } from "./pages/AnalyzePage";
import { HomePage } from "./pages/HomePage";
import { ReportPage } from "./pages/ReportPage";
import { AnalysisReportProvider } from "./reportState";

export function App() {
  return (
    <AnalysisReportProvider>
      <Routes>
        <Route element={<AppLayout />} path="/">
          <Route index element={<HomePage />} />
          <Route element={<AnalyzePage />} path="analyze" />
          <Route element={<ReportPage />} path="report" />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Route>
      </Routes>
    </AnalysisReportProvider>
  );
}
