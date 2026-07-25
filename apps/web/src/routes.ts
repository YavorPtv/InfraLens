export type AppRoute = "/" | "/analyze" | "/compare" | "/report";

export interface NavItem {
  path: AppRoute;
  label: string;
}

export const navItems: NavItem[] = [
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
