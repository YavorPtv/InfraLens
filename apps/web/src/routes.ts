export type AppRoute = "/" | "/analyze" | "/report";

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
    path: "/report",
    label: "Report"
  }
];

export function getPageTitle(pathname: string): string {
  switch (pathname) {
    case "/analyze":
      return "Analyze a Template";
    case "/report":
      return "Report Preview";
    default:
      return "CloudFormation Risk Review";
  }
}
