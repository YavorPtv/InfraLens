import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AppLayout } from "./components/AppLayout";
import { HomePage } from "./pages/HomePage";
import { AuthCallbackPage } from "./pages/AuthCallbackPage";
import { SignInPage } from "./pages/SignInPage";
import { AnalysisReportProvider } from "./reportState";

const AnalyzePage = lazy(() => import("./pages/AnalyzePage").then(module => ({ default: module.AnalyzePage })));
const ComparePage = lazy(() => import("./pages/ComparePage").then(module => ({ default: module.ComparePage })));
const ReportPage = lazy(() => import("./pages/ReportPage").then(module => ({ default: module.ReportPage })));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then(module => ({ default: module.ProjectsPage })));
const SavedReportPage = lazy(() => import("./pages/SavedReportPage").then(module => ({ default: module.SavedReportPage })));

export function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}

function AuthenticatedApp() {
  const { authenticated, enabled, loading } = useAuth();

  if (enabled && window.location.pathname === "/auth/callback") {
    return <AuthCallbackPage />;
  }

  if (loading) {
    return <main className="auth-page"><p>Loading session...</p></main>;
  }

  if (enabled && !authenticated) {
    return <SignInPage />;
  }

  return (
    <AnalysisReportProvider>
      <Routes>
        <Route element={<AppLayout />} path="/">
          <Route index element={<HomePage />} />
          <Route element={<AnalyzePage />} path="analyze" />
          <Route element={<ComparePage />} path="compare" />
          <Route element={<ReportPage />} path="report" />
          <Route element={<ProjectsPage />} path="projects" />
          <Route element={<ProjectsPage />} path="projects/:projectId" />
          <Route element={<SavedReportPage />} path="projects/:projectId/runs/:runId" />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Route>
      </Routes>
    </AnalysisReportProvider>
  );
}
