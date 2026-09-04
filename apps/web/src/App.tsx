import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AppLayout } from "./components/AppLayout";
import { AnalyzePage } from "./pages/AnalyzePage";
import { ComparePage } from "./pages/ComparePage";
import { HomePage } from "./pages/HomePage";
import { ReportPage } from "./pages/ReportPage";
import { AuthCallbackPage } from "./pages/AuthCallbackPage";
import { SignInPage } from "./pages/SignInPage";
import { AnalysisReportProvider } from "./reportState";

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
          <Route element={<Navigate replace to="/" />} path="*" />
        </Route>
      </Routes>
    </AnalysisReportProvider>
  );
}
