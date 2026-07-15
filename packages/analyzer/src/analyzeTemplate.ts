import type {
  AnalysisContext,
  AnalysisReport,
  AnalysisSummary,
  CfnTemplate,
  Finding,
  Rule,
  Severity,
  SeverityCounts
} from "@infralens/shared";
import { createAnalysisContext } from "./analysisContext";
import { applyContextualSeverityAdjustments } from "./contextualSeverity";
import { parseTemplate } from "./parseTemplate";
import { extractCloudFormationReferences, referencesToArchitectureEdges } from "./extractReferences";
import { generateLeastPrivilegeResourceSuggestions } from "./leastPrivilegeSuggestions";
import { detectPublicEntryPoints } from "./publicEntryPoints";
import { findPubliclyReachableResources } from "./publicReachability";
import { buildRuntimeArchitectureGraph } from "./runtimeGraph";
import { apiGatewayMethodNoAuthRule } from "./rules/apiGatewayMethodNoAuth";
import { dynamodbMissingPitrRule } from "./rules/dynamodbMissingPitr";
import { iamWildcardPermissionsRule } from "./rules/iamWildcardPermissions";
import { logGroupMissingRetentionRule } from "./rules/logGroupMissingRetention";
import { s3PublicAccessBlockMissingRule } from "./rules/s3PublicAccessBlockMissing";
import { sqsMissingDlqRule } from "./rules/sqsMissingDlq";

const rules: Rule[] = [
  iamWildcardPermissionsRule,
  sqsMissingDlqRule,
  dynamodbMissingPitrRule,
  logGroupMissingRetentionRule,
  s3PublicAccessBlockMissingRule,
  apiGatewayMethodNoAuthRule
];

const severityWeights: Record<Severity, number> = {
  low: 5,
  medium: 10,
  high: 20,
  critical: 30
};

export function analyzeTemplate(rawJson: string): AnalysisReport {
  const resources = parseTemplate(rawJson);
  const template = JSON.parse(rawJson) as CfnTemplate;
  const referenceEdges = referencesToArchitectureEdges(extractCloudFormationReferences(template));
  const edges = [...referenceEdges, ...buildRuntimeArchitectureGraph(template)];
  const publicEntryPointIds = detectPublicEntryPoints(template);
  const publiclyReachableResourceIds = [
    ...findPubliclyReachableResources(publicEntryPointIds, edges)
  ];
  const leastPrivilegeSuggestions = generateLeastPrivilegeResourceSuggestions(template);
  const context = createAnalysisContext({
    template,
    resources,
    edges,
    publiclyReachableResourceIds
  });
  const findings = applyContextualSeverityAdjustments(runRules(rules, context), context);
  const summary = summarizeFindings(findings);

  return {
    findings,
    resources,
    edges: context.edges,
    publicEntryPointIds,
    publiclyReachableResourceIds: context.publiclyReachableResourceIds,
    leastPrivilegeSuggestions,
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
