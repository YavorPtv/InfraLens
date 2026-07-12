import type { AnalysisContext, CfnResource, CfnValue, Finding, Rule } from "@infralens/shared";

const RULE_ID = "IAM_WILDCARD_PERMISSIONS";

interface PolicyStatementLocation {
  resourceId: string;
  statement: Record<string, CfnValue>;
  evidencePath: string;
}

export const iamWildcardPermissionsRule: Rule = {
  id: RULE_ID,
  title: "IAM policy allows wildcard actions on wildcard resources",
  severity: "high",
  evaluate(context: AnalysisContext): Finding[] {
    return findPolicyStatements(context)
      .filter(({ statement }) => isWildcardAllowStatement(statement))
      .map(({ resourceId, evidencePath }) => ({
        ruleId: RULE_ID,
        title: "IAM policy allows wildcard actions on wildcard resources",
        severity: "high",
        resourceId,
        explanation:
          "This IAM policy statement allows wildcard permissions against wildcard resources, which can grant broader access than intended.",
        evidencePath,
        suggestion:
          "Replace wildcard actions and resources with the smallest specific actions and resource ARNs required by the workload."
      }));
  }
};

function findPolicyStatements(context: AnalysisContext): PolicyStatementLocation[] {
  return Object.entries(context.template.Resources).flatMap(([resourceId, resource]) => {
    if (resource.Type === "AWS::IAM::Role") {
      return findRoleInlinePolicyStatements(resourceId, resource);
    }

    if (resource.Type === "AWS::IAM::Policy") {
      return findPolicyResourceStatements(resourceId, resource);
    }

    return [];
  });
}

function findRoleInlinePolicyStatements(
  resourceId: string,
  resource: CfnResource
): PolicyStatementLocation[] {
  const policies = resource.Properties?.Policies;

  if (!Array.isArray(policies)) {
    return [];
  }

  return policies.flatMap((policy, policyIndex) => {
    if (!isRecord(policy)) {
      return [];
    }

    return findStatementsInPolicyDocument(
      resourceId,
      policy.PolicyDocument,
      `Resources.${resourceId}.Properties.Policies[${policyIndex}].PolicyDocument`
    );
  });
}

function findPolicyResourceStatements(
  resourceId: string,
  resource: CfnResource
): PolicyStatementLocation[] {
  return findStatementsInPolicyDocument(
    resourceId,
    resource.Properties?.PolicyDocument,
    `Resources.${resourceId}.Properties.PolicyDocument`
  );
}

function findStatementsInPolicyDocument(
  resourceId: string,
  policyDocument: CfnValue | undefined,
  policyDocumentPath: string
): PolicyStatementLocation[] {
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

  if (isRecord(statements)) {
    return [
      {
        resourceId,
        statement: statements,
        evidencePath: `${policyDocumentPath}.Statement`
      }
    ];
  }

  return [];
}

function isWildcardAllowStatement(statement: Record<string, CfnValue>): boolean {
  return (
    statement.Effect === "Allow" &&
    containsWildcardString(statement.Action) &&
    containsWildcardString(statement.Resource)
  );
}

function containsWildcardString(value: CfnValue | undefined): boolean {
  if (typeof value === "string") {
    return value.includes("*");
  }

  if (Array.isArray(value)) {
    return value.some((item) => typeof item === "string" && item.includes("*"));
  }

  return false;
}

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
