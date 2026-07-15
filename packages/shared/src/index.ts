export type CfnPrimitive = string | number | boolean | null;

export type CfnValue = CfnPrimitive | CfnValue[] | { [key: string]: CfnValue };

export interface CfnResource {
  Type: string;
  Properties?: Record<string, CfnValue>;
  Metadata?: Record<string, CfnValue>;
  DependsOn?: string | string[];
  Condition?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  CreationPolicy?: Record<string, CfnValue>;
  UpdatePolicy?: Record<string, CfnValue>;
}

export interface CfnTemplate {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Transform?: string | string[];
  Metadata?: Record<string, CfnValue>;
  Parameters?: Record<string, CfnValue>;
  Mappings?: Record<string, CfnValue>;
  Conditions?: Record<string, CfnValue>;
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, CfnValue>;
}

export interface ResourceNode {
  id: string;
  type: string;
  properties?: Record<string, CfnValue>;
  dependsOn?: string[];
}

export type ArchitectureRelationship =
  | "references"
  | "depends-on"
  | "uses-role"
  | "invokes"
  | "reads"
  | "writes"
  | "sends-message"
  | "dead-letter";

export interface ArchitectureEdge {
  from: string;
  to: string;
  relationship: ArchitectureRelationship;
  evidencePath: string;
}

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

export type SeverityCounts = Record<Severity, number>;

export interface AnalysisSummary {
  totalFindings: number;
  bySeverity: SeverityCounts;
}

export interface AnalysisReport {
  findings: Finding[];
  resources: ResourceNode[];
  edges: ArchitectureEdge[];
  publiclyReachableResourceIds: string[];
  summary: AnalysisSummary;
  score: number;
}

export interface AnalysisContext {
  template: CfnTemplate;
  resources: ResourceNode[];
  edges: ArchitectureEdge[];
  publiclyReachableResourceIds: string[];
}

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  evaluate: (context: AnalysisContext) => Finding[];
}
