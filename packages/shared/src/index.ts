export {
  normalizeSourceFilePath,
  normalizeSourceAnalysisInput,
  SourcePathError,
  type SourceFile,
  type SourceAnalysisInput,
  type AnalyzeApiRequest
} from "./sourceFiles";

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

export type TemplatePathSegment = string | number;

export type TemplateFixConfidence = "low" | "medium" | "high";

export interface TemplatePatch {
  targetResourceId: ResourceId;
  targetResourceType: string;
  path: TemplatePathSegment[];
  operation: "set";
  value: CfnValue;
  allowCreate: boolean;
  expectedValue?: CfnValue;
}

export type TemplateFixSource =
  | {
      kind: "finding";
      ruleId: RuleId;
      evidencePath: EvidencePath;
    }
  | {
      kind: "least-privilege";
      lambdaFunctionId: ResourceId;
      roleId: ResourceId;
      evidencePath: EvidencePath;
    };

export interface TemplateFix {
  id: string;
  title: string;
  targetResourceId: ResourceId;
  targetResourceType: string;
  applicability: "applicable" | "manual-review";
  confidence: TemplateFixConfidence;
  explanation: string;
  source: TemplateFixSource;
  patches: TemplatePatch[];
}

export interface ApplyFixResult {
  fixId: string;
  status: "applied" | "failed";
  message: string;
}

export interface ApplySuggestionsResult {
  modifiedTemplate: CfnTemplate;
  appliedFixCount: number;
  failedFixCount: number;
  results: ApplyFixResult[];
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
  sourceActions?: PolicySuggestionSourceActionEvidence[];
}

export interface PolicySuggestionSourceActionEvidence {
  action: string;
  filePath: string;
  lambdaFunctionId: ResourceId;
  rootFilePath?: string;
  importChain?: string[];
  matchedCommand: string;
  confidence: "low" | "medium" | "high";
  actionConfidence?: "low" | "medium" | "high";
  sdkPackage?: string;
  evidence: EvidencePath;
}

export type PolicySuggestionService =
  | "dynamodb"
  | "s3"
  | "sqs"
  | "sns"
  | "lambda"
  | "events"
  | "secretsmanager"
  | "ssm"
  | "kms";

export interface PolicySuggestion {
  lambdaFunctionId: ResourceId;
  roleId: ResourceId;
  policyName?: string;
  policySourceType: "inline-role-policy" | "policy-resource";
  policyResourceId?: ResourceId;
  service: PolicySuggestionService;
  currentActions: string[];
  suggestedActions: string[];
  actions: string[];
  currentResource: CfnValue;
  confidence: PolicySuggestionConfidence;
  suggestedResources: PolicySuggestionResourceCandidate[];
  explanation: string;
  manualOnly?: boolean;
  manualReviewReason?: string;
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
  templateFixes?: TemplateFix[];
}

export interface ChangedResource {
  resourceId: ResourceId;
  oldResource: ResourceNode;
  newResource: ResourceNode;
}

export interface ResourceDiffSummary {
  added: ResourceNode[];
  removed: ResourceNode[];
  changed: ChangedResource[];
}

export interface FindingDiffSummary {
  introduced: Finding[];
  resolved: Finding[];
  unchanged: Finding[];
}

export interface DiffReport {
  oldReport: AnalysisReport;
  newReport: AnalysisReport;
  resources: ResourceDiffSummary;
  findings: FindingDiffSummary;
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

export {
  exportAnalysisReportToJson,
  exportAnalysisReportToMarkdown,
  exportDiffReportToMarkdown
} from "./reportExport";
