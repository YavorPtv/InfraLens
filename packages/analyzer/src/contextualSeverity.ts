import type { AnalysisContext, Finding } from "@infralens/shared";
import { hasIamModifiers } from "./iamPolicyModel";

const IAM_WILDCARD_PERMISSIONS_RULE_ID = "IAM_WILDCARD_PERMISSIONS";

export function applyContextualSeverityAdjustments(
  findings: Finding[],
  context: AnalysisContext
): Finding[] {
  const publiclyReachableResourceIds = new Set(context.publiclyReachableResourceIds);

  return findings.map((finding) =>
    shouldEscalateIamWildcardFinding(finding, context, publiclyReachableResourceIds)
      ? {
          ...finding,
          severityAdjustment: {
            from: finding.severity,
            to: "critical",
            reason:
              "IAM wildcard permissions are on a role that is publicly reachable or used by a publicly reachable Lambda function."
          },
          severity: "critical"
        }
      : finding
  );
}

function shouldEscalateIamWildcardFinding(
  finding: Finding,
  context: AnalysisContext,
  publiclyReachableResourceIds: Set<string>
): boolean {
  return (
    finding.ruleId === IAM_WILDCARD_PERMISSIONS_RULE_ID &&
    !(finding.iamContext && hasIamModifiers(finding.iamContext)) &&
    finding.severity !== "critical" &&
    [finding.resourceId, ...(finding.iamContext?.principalIds ?? [])].some(id =>
      isPubliclyReachableRole(id, context, publiclyReachableResourceIds))
  );
}

function isPubliclyReachableRole(
  resourceId: string,
  context: AnalysisContext,
  publiclyReachableResourceIds: Set<string>
): boolean {
  if (publiclyReachableResourceIds.has(resourceId)) {
    return true;
  }

  return context.edges.some(
    (edge) =>
      edge.relationship === "uses-role" &&
      edge.to === resourceId &&
      publiclyReachableResourceIds.has(edge.from)
  );
}
