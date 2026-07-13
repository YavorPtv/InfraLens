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
import { parseTemplate } from "./parseTemplate";
import { extractCloudFormationReferences, referencesToArchitectureEdges } from "./extractReferences";
import { dynamodbMissingPitrRule } from "./rules/dynamodbMissingPitr";
import { iamWildcardPermissionsRule } from "./rules/iamWildcardPermissions";
import { logGroupMissingRetentionRule } from "./rules/logGroupMissingRetention";
import { sqsMissingDlqRule } from "./rules/sqsMissingDlq";

const rules: Rule[] = [
  iamWildcardPermissionsRule,
  sqsMissingDlqRule,
  dynamodbMissingPitrRule,
  logGroupMissingRetentionRule
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
  const edges = referencesToArchitectureEdges(extractCloudFormationReferences(template));
  const context: AnalysisContext = {
    template,
    resources,
    edges
  };
  const findings = runRules(rules, context);
  const summary = summarizeFindings(findings);

  return {
    findings,
    resources,
    edges: context.edges,
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
