export type ValidationStatus = "valid" | "invalid" | "not-run" | "unavailable";
export type AnalysisStatus = "completed" | "failed" | "not-run";
export type ValidationStage = "parse" | "structure" | "cloudFormation";

export interface ValidationIssue {
  stage: ValidationStage;
  code: string;
  message: string;
  path?: string;
  severity: "error" | "warning";
  /** Possible contributors, not proof of causation. */
  relatedFixIds?: string[];
}

export interface TemplateValidationResult {
  parse: ValidationStatus;
  structure: ValidationStatus;
  cloudFormation: ValidationStatus;
  issues: ValidationIssue[];
}

export type GeneratedTemplateStatus = "ready" | "review-required" | "invalid";

export function getGeneratedTemplateStatus(validation: TemplateValidationResult): GeneratedTemplateStatus {
  if (validation.parse !== "valid" || validation.structure !== "valid" ||
      validation.cloudFormation === "invalid") return "invalid";
  return validation.cloudFormation === "valid" ? "ready" : "review-required";
}

export function canDownloadGeneratedTemplate(validation: TemplateValidationResult | undefined): boolean {
  return validation !== undefined && getGeneratedTemplateStatus(validation) !== "invalid";
}

export function formatValidationSummary(validation: TemplateValidationResult, analysisStatus?: AnalysisStatus): string[] {
  return [
    `Parse: ${validation.parse}`,
    `CloudFormation structure: ${validation.structure}`,
    ...(analysisStatus === undefined ? [] : [`Analyzer: ${analysisStatus}`]),
    `AWS CloudFormation validation: ${validation.cloudFormation}`,
    ...validation.issues.map(issue => `${issue.code}${issue.path ? ` (${issue.path})` : ""}: ${issue.message}`),
    "Passing validation does not guarantee stack deployment will succeed."
  ];
}
