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
  id: ResourceId;
  type: string;
  properties?: Record<string, CfnValue>;
  dependsOn?: string[];
}

export type ResourceId = string;

export type EvidencePath = string;

export type AnalysisScore = number;

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
  from: ResourceId;
  to: ResourceId;
  relationship: ArchitectureRelationship;
  evidencePath: EvidencePath;
}

export type Severity = "low" | "medium" | "high" | "critical";

export type RuleId = string;

export interface Finding {
  ruleId: RuleId;
  title: string;
  severity: Severity;
  resourceId: ResourceId;
  explanation: string;
  evidencePath: EvidencePath;
  suggestion: string;
  severityAdjustment?: SeverityAdjustment;
}

export interface SeverityAdjustment {
  from: Severity;
  to: Severity;
  reason: string;
}

export type PolicySuggestionConfidence = "low" | "medium" | "high";

export interface PolicySuggestionResourceCandidate {
  resourceId: ResourceId;
  resourceType: string;
  referenceEvidencePath: EvidencePath;
  suggestedResource: CfnValue;
}

export interface PolicySuggestionEvidence {
  lambdaFunctionId: ResourceId;
  lambdaRoleEvidencePath: EvidencePath;
  policyEvidencePath: EvidencePath;
  statementEvidencePath: EvidencePath;
  inferredResources: PolicySuggestionResourceCandidate[];
}

export interface PolicySuggestion {
  lambdaFunctionId: ResourceId;
  roleId: ResourceId;
  policyName?: string;
  policySourceType: "inline-role-policy" | "policy-resource";
  policyResourceId?: ResourceId;
  service: "dynamodb" | "sqs" | "sns";
  actions: string[];
  currentResource: CfnValue;
  confidence: PolicySuggestionConfidence;
  suggestedResources: PolicySuggestionResourceCandidate[];
  explanation: string;
  evidence: PolicySuggestionEvidence;
}

export type SeverityCounts = Record<Severity, number>;

export interface AnalysisSummary {
  totalFindings: number;
  bySeverity: SeverityCounts;
}

export interface AnalysisGraph {
  resources: ResourceNode[];
  edges: ArchitectureEdge[];
}

export interface PublicExposure {
  publicEntryPointIds: ResourceId[];
  publiclyReachableResourceIds: ResourceId[];
}

export interface AnalysisReport extends AnalysisGraph, PublicExposure {
  score: AnalysisScore;
  summary: AnalysisSummary;
  findings: Finding[];
  leastPrivilegeSuggestions: PolicySuggestion[];
}

export interface AnalysisContext extends AnalysisGraph, Pick<PublicExposure, "publiclyReachableResourceIds"> {
  template: CfnTemplate;
}

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  evaluate: (context: AnalysisContext) => Finding[];
}
