import type {
  AnalysisContext,
  AnalysisReport,
  AnalysisSummary,
  Finding,
  Rule,
  Severity,
  SeverityCounts
} from "@infralens/shared";
import type { SourceAnalysisInput } from "@infralens/shared";
import { createAnalysisContext } from "./analysisContext";
import { applyContextualSeverityAdjustments } from "./contextualSeverity";
import { validateTemplate, TemplateValidationError, templateToResourceNodes } from "./parseTemplate";
import { extractCloudFormationReferences, referencesToArchitectureEdges } from "./extractReferences";
import { generateLeastPrivilegeResourceSuggestions } from "./leastPrivilegeSuggestions";
import { detectPublicEntryPoints } from "./publicEntryPoints";
import { findPubliclyReachableResources } from "./publicReachability";
import { buildRuntimeArchitectureGraph } from "./runtimeGraph";
import { inferIamActionsFromSourceCode } from "./sourceCodeAnalysis";
import { generateTemplateFixes } from "./templateFixes";
import { apiGatewayMethodNoAuthRule } from "./rules/apiGatewayMethodNoAuth";
import { apiGatewayAccessLoggingMissingRule } from "./rules/apiGatewayAccessLoggingMissing";
import { apiGatewayTracingDisabledRule } from "./rules/apiGatewayTracingDisabled";
import { dynamodbDeletionProtectionDisabledRule } from "./rules/dynamodbDeletionProtectionDisabled";
import { dynamodbMissingPitrRule } from "./rules/dynamodbMissingPitr";
import { iamPassRoleWildcardRule } from "./rules/iamPassRoleWildcard";
import { iamPrivilegeEscalationActionsRule } from "./rules/iamPrivilegeEscalationActions";
import { iamWildcardPermissionsRule } from "./rules/iamWildcardPermissions";
import { lambdaAsyncFailureDestinationMissingRule } from "./rules/lambdaAsyncFailureDestinationMissing";
import { lambdaReservedConcurrencyZeroRule } from "./rules/lambdaReservedConcurrencyZero";
import { lambdaTracingDisabledRule } from "./rules/lambdaTracingDisabled";
import { logGroupMissingRetentionRule } from "./rules/logGroupMissingRetention";
import { s3PublicAccessBlockMissingRule } from "./rules/s3PublicAccessBlockMissing";
import { s3VersioningDisabledRule } from "./rules/s3VersioningDisabled";
import { snsTopicEncryptionMissingRule } from "./rules/snsTopicEncryptionMissing";
import { sqsMissingDlqRule } from "./rules/sqsMissingDlq";

const rules: Rule[] = [
  iamWildcardPermissionsRule,
  iamPassRoleWildcardRule,
  iamPrivilegeEscalationActionsRule,
  sqsMissingDlqRule,
  dynamodbMissingPitrRule,
  dynamodbDeletionProtectionDisabledRule,
  logGroupMissingRetentionRule,
  s3PublicAccessBlockMissingRule,
  s3VersioningDisabledRule,
  snsTopicEncryptionMissingRule,
  apiGatewayMethodNoAuthRule,
  apiGatewayAccessLoggingMissingRule,
  apiGatewayTracingDisabledRule,
  lambdaTracingDisabledRule,
  lambdaReservedConcurrencyZeroRule,
  lambdaAsyncFailureDestinationMissingRule
];

const severityWeights: Record<Severity, number> = {
  low: 5,
  medium: 10,
  high: 20,
  critical: 30
};

export interface AnalyzeTemplateOptions extends SourceAnalysisInput {}

export function analyzeTemplate(
  rawTemplate: string,
  options: AnalyzeTemplateOptions = {}
): AnalysisReport {
  const { template, validation } = validateTemplate(rawTemplate);
  if (template === undefined) throw new TemplateValidationError(validation);
  const resources = templateToResourceNodes(template);
  const referenceEdges = referencesToArchitectureEdges(extractCloudFormationReferences(template));
  const edges = [...referenceEdges, ...buildRuntimeArchitectureGraph(template)];
  const publicEntryPointIds = detectPublicEntryPoints(template);
  const publiclyReachableResourceIds = [
    ...findPubliclyReachableResources(publicEntryPointIds, edges)
  ];
  const sourceActionInferences =
    options.sourceFiles === undefined
      ? []
      : inferIamActionsFromSourceCode(options.sourceFiles, {
          template,
          sourceFileMappings: options.sourceFileMappings,
          sourceFileExclusions: options.sourceFileExclusions
        });
  const leastPrivilegeSuggestions = generateLeastPrivilegeResourceSuggestions(template, {
    sourceActionInferences
  });
  const context = createAnalysisContext({
    template,
    resources,
    edges,
    publiclyReachableResourceIds
  });
  const findings = applyContextualSeverityAdjustments(runRules(rules, context), context);
  const summary = summarizeFindings(findings);
  const templateFixes = generateTemplateFixes(template, findings, leastPrivilegeSuggestions);

  return {
    analysisStatus: "completed",
    validation,
    findings,
    resources,
    edges: context.edges,
    publicEntryPointIds,
    publiclyReachableResourceIds: context.publiclyReachableResourceIds,
    leastPrivilegeSuggestions,
    templateFixes,
    summary,
    score: calculateScore(summary.bySeverity)
  };
}

function runRules(ruleList: Rule[], context: AnalysisContext): Finding[] {
  return ruleList.flatMap((rule) => rule.evaluate(context));
}

function summarizeFindings(findings: Finding[]): AnalysisSummary {
  const bySeverity: SeverityCounts = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0
  };

  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
  }

  return {
    totalFindings: findings.length,
    bySeverity
  };
}

function calculateScore(counts: SeverityCounts): number {
  const penalty = Object.entries(counts).reduce((total, [severity, count]) => {
    return total + severityWeights[severity as Severity] * count;
  }, 0);

  return Math.max(0, Math.min(100, 100 - penalty));
}
