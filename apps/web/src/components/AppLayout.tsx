import { Outlet, useLocation } from "react-router-dom";
import { Header } from "./Header";
import { getPageTitle } from "../routes";

export function AppLayout() {
  const location = useLocation();
  const pageTitle = getPageTitle(location.pathname);

  return (
    <div className="app-shell">
      <Header />
      <main className="main-content" aria-labelledby="page-title">
        <div className="page-kicker">AWS architecture analysis</div>
        <h1 id="page-title">{pageTitle}</h1>
        <Outlet />
      </main>
    </div>
  );
}
