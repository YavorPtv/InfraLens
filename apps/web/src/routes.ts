export type AppRoute = "/" | "/analyze" | "/compare" | "/report" | "/projects";

export interface NavItem {
  path: AppRoute;
  label: string;
}

export const navItems: NavItem[] = [
  {
    path: "/projects",
    label: "Projects"
  },
  {
    path: "/",
    label: "Home"
  },
  {
    path: "/analyze",
    label: "Analyze"
  },
  {
    path: "/compare",
    label: "Compare"
  },
  {
    path: "/report",
    label: "Report"
  }
];

export function getPageTitle(pathname: string): string {
  if (pathname.startsWith("/projects")) {
    return "Saved Projects";
  }
  switch (pathname) {
    case "/analyze":
      return "Analyze a Template";
    case "/compare":
      return "Compare Templates";
    case "/report":
      return "Report Preview";
    default:
      return "CloudFormation Risk Review";
  }
}
