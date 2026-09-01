import type { CfnResource, CfnTemplate, CfnValue } from "@infralens/shared";

export interface IamPolicyStatementLocation {
  resourceId: string;
  statement: Record<string, CfnValue>;
  evidencePath: string;
}

export function findIamPolicyStatements(template: CfnTemplate): IamPolicyStatementLocation[] {
  return Object.entries(template.Resources).flatMap(([resourceId, resource]) => {
    if (resource.Type === "AWS::IAM::Role") {
      return findRoleInlinePolicyStatements(resourceId, resource);
    }

    if (resource.Type === "AWS::IAM::Policy") {
      return findStatementsInPolicyDocument(
        resourceId,
        resource.Properties?.PolicyDocument,
        `Resources.${resourceId}.Properties.PolicyDocument`
      );
    }

    return [];
  });
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

function findRoleInlinePolicyStatements(
  resourceId: string,
  resource: CfnResource
): IamPolicyStatementLocation[] {
  const policies = resource.Properties?.Policies;
  if (!Array.isArray(policies)) {
    return [];
  }

  return policies.flatMap((policy, policyIndex) =>
    isRecord(policy)
      ? findStatementsInPolicyDocument(
          resourceId,
          policy.PolicyDocument,
          `Resources.${resourceId}.Properties.Policies[${policyIndex}].PolicyDocument`
        )
      : []
  );
}

function findStatementsInPolicyDocument(
  resourceId: string,
  policyDocument: CfnValue | undefined,
  policyDocumentPath: string
): IamPolicyStatementLocation[] {
  if (!isRecord(policyDocument)) {
    return [];
  }

  const statements = policyDocument.Statement;
  if (Array.isArray(statements)) {
    return statements.flatMap((statement, statementIndex) =>
      isRecord(statement)
        ? [
            {
              resourceId,
              statement,
              evidencePath: `${policyDocumentPath}.Statement[${statementIndex}]`
            }
          ]
        : []
    );
  }

  return isRecord(statements)
    ? [{ resourceId, statement: statements, evidencePath: `${policyDocumentPath}.Statement` }]
    : [];
}

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
