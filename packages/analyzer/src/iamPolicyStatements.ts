import type { CfnTemplate, CfnValue } from "@infralens/shared";

import { buildIamAnalysis, policyStatements } from "./iamPolicyModel";

export interface IamPolicyStatementLocation {
  resourceId: string;
  statement: Record<string, CfnValue>;
  evidencePath: string;
}

export function findIamPolicyStatements(template: CfnTemplate, model = buildIamAnalysis(template)): IamPolicyStatementLocation[] {
  return model.policies
    .filter(policy => policy.boundaryFor.length === 0 || policy.principalIds.length > 0)
    .flatMap(policy => policyStatements(policy).map(location => ({ resourceId: policy.resourceId, ...location })));
}

export function getIamActionStrings(value: CfnValue | undefined): string[] {
  if (typeof value === "string") {
    return [value];
  }

  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function hasWildcardResource(value: CfnValue | undefined): boolean {
  return value === "*" || (Array.isArray(value) && value.some((item) => item === "*"));
}
