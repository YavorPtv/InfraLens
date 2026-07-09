export type Severity = "low" | "medium" | "high" | "critical";

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  resourceId: string;
  explanation: string;
  evidencePath: string;
  suggestion: string;
}
