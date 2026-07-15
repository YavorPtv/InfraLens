import type {
  CfnTemplate,
  CfnValue,
  PolicySuggestion,
  PolicySuggestionConfidence,
  PolicySuggestionResourceCandidate
} from "@infralens/shared";
import {
  findLambdaExecutionRole,
  findPolicyResourcesAttachedToRole,
  findRoleInlinePolicies,
  type AttachedPolicyResourceLookup,
  type InlineRolePolicyLookup,
  type LambdaRoleLookup
} from "./iamPolicyLookup";
import { extractResourceReferences, type ResourceReference } from "./resourceReferences";

interface SupportedService {
  service: PolicySuggestion["service"];
  resourceType: string;
  suggestedResourceFor: (resourceId: string) => CfnValue;
}

interface PolicyDocumentLookup {
  policyName?: string;
  policySourceType: PolicySuggestion["policySourceType"];
  policyResourceId?: string;
  policyDocument?: CfnValue;
  policyEvidencePath: string;
}

interface PolicyStatementLookup {
  statement: Record<string, CfnValue>;
  evidencePath: string;
}

const supportedServices: SupportedService[] = [
  {
    service: "dynamodb",
    resourceType: "AWS::DynamoDB::Table",
    suggestedResourceFor: (resourceId) => ({
      "Fn::GetAtt": [resourceId, "Arn"]
    })
  },
  {
    service: "sqs",
    resourceType: "AWS::SQS::Queue",
    suggestedResourceFor: (resourceId) => ({
      "Fn::GetAtt": [resourceId, "Arn"]
    })
  },
  {
    service: "sns",
    resourceType: "AWS::SNS::Topic",
    suggestedResourceFor: (resourceId) => ({
      Ref: resourceId
    })
  }
];

export function generateLeastPrivilegeResourceSuggestions(
  template: CfnTemplate
): PolicySuggestion[] {
  return Object.entries(template.Resources).flatMap(([resourceId, resource]) => {
    if (resource.Type !== "AWS::Lambda::Function") {
      return [];
    }

    const lambdaRole = findLambdaExecutionRole(template, resourceId);
    if (lambdaRole === undefined) {
      return [];
    }

    return generateSuggestionsForLambdaRole(template, lambdaRole);
  });
}

function generateSuggestionsForLambdaRole(
  template: CfnTemplate,
  lambdaRole: LambdaRoleLookup
): PolicySuggestion[] {
  const lambdaReferences = extractResourceReferences(
    lambdaRole.lambdaFunction,
    `Resources.${lambdaRole.lambdaFunctionId}`
  );

  return getPolicyDocumentsForRole(template, lambdaRole.roleId).flatMap((policy) =>
    findPolicyStatements(policy).flatMap(({ statement, evidencePath }) =>
      createSuggestionsForStatement(
        template,
        lambdaRole,
        lambdaReferences,
        policy,
        statement,
        evidencePath
      )
    )
  );
}

function getPolicyDocumentsForRole(template: CfnTemplate, roleId: string): PolicyDocumentLookup[] {
  return [
    ...findRoleInlinePolicies(template, roleId).map(toInlinePolicyDocumentLookup),
    ...findPolicyResourcesAttachedToRole(template, roleId).map(toAttachedPolicyDocumentLookup)
  ];
}

function toInlinePolicyDocumentLookup(policy: InlineRolePolicyLookup): PolicyDocumentLookup {
  return {
    policyName: policy.policyName,
    policySourceType: "inline-role-policy",
    policyDocument: policy.policyDocument,
    policyEvidencePath: policy.evidencePath
  };
}

function toAttachedPolicyDocumentLookup(policy: AttachedPolicyResourceLookup): PolicyDocumentLookup {
  return {
    policyName: policy.policyName,
    policySourceType: "policy-resource",
    policyResourceId: policy.policyResourceId,
    policyDocument: policy.policyDocument,
    policyEvidencePath: `${policy.evidencePath}.Properties`
  };
}

function findPolicyStatements(policy: PolicyDocumentLookup): PolicyStatementLookup[] {
  if (!isRecord(policy.policyDocument)) {
    return [];
  }

  const statements = policy.policyDocument.Statement;
  const statementPath = `${policy.policyEvidencePath}.PolicyDocument.Statement`;

  if (Array.isArray(statements)) {
    return statements.flatMap((statement, statementIndex) =>
      isRecord(statement)
        ? [
            {
              statement,
              evidencePath: `${statementPath}[${statementIndex}]`
            }
          ]
        : []
    );
  }

  if (isRecord(statements)) {
    return [
      {
        statement: statements,
        evidencePath: statementPath
      }
    ];
  }

  return [];
}

function createSuggestionsForStatement(
  template: CfnTemplate,
  lambdaRole: LambdaRoleLookup,
  lambdaReferences: ResourceReference[],
  policy: PolicyDocumentLookup,
  statement: Record<string, CfnValue>,
  statementEvidencePath: string
): PolicySuggestion[] {
  if (statement.Effect !== "Allow" || !isWildcardResource(statement.Resource)) {
    return [];
  }

  const actions = getActionStrings(statement.Action);

  return supportedServices.flatMap((service) => {
    const matchingActions = actions.filter((action) => isActionForService(action, service.service));
    if (matchingActions.length === 0) {
      return [];
    }

    const suggestedResources = findReferencedResourceCandidates(
      template,
      lambdaReferences,
      service
    );

    return [
      {
        lambdaFunctionId: lambdaRole.lambdaFunctionId,
        roleId: lambdaRole.roleId,
        policySourceType: policy.policySourceType,
        ...(policy.policyName === undefined ? {} : { policyName: policy.policyName }),
        ...(policy.policyResourceId === undefined
          ? {}
          : { policyResourceId: policy.policyResourceId }),
        service: service.service,
        actions: matchingActions,
        currentResource: statement.Resource,
        confidence: getConfidence(suggestedResources),
        suggestedResources,
        explanation: buildExplanation(service.service, suggestedResources),
        evidence: {
          lambdaFunctionId: lambdaRole.lambdaFunctionId,
          lambdaRoleEvidencePath: lambdaRole.evidencePath,
          policyEvidencePath: policy.policyEvidencePath,
          statementEvidencePath,
          inferredResources: suggestedResources
        }
      }
    ];
  });
}

function findReferencedResourceCandidates(
  template: CfnTemplate,
  references: ResourceReference[],
  service: SupportedService
): PolicySuggestionResourceCandidate[] {
  const candidatesById = new Map<string, PolicySuggestionResourceCandidate>();

  for (const reference of references) {
    const resource = template.Resources[reference.resourceId];
    if (resource?.Type !== service.resourceType || candidatesById.has(reference.resourceId)) {
      continue;
    }

    candidatesById.set(reference.resourceId, {
      resourceId: reference.resourceId,
      resourceType: resource.Type,
      referenceEvidencePath: reference.evidencePath,
      suggestedResource: service.suggestedResourceFor(reference.resourceId)
    });
  }

  return [...candidatesById.values()];
}

function getActionStrings(action: CfnValue | undefined): string[] {
  if (typeof action === "string") {
    return [action];
  }

  if (Array.isArray(action)) {
    return action.filter((item): item is string => typeof item === "string");
  }

  return [];
}

function isActionForService(action: string, service: string): boolean {
  return action.toLowerCase().startsWith(`${service}:`);
}

function isWildcardResource(resource: CfnValue | undefined): resource is CfnValue {
  if (resource === "*") {
    return true;
  }

  return Array.isArray(resource) && resource.some((item) => item === "*");
}

function getConfidence(
  suggestedResources: PolicySuggestionResourceCandidate[]
): PolicySuggestionConfidence {
  if (suggestedResources.length === 1) {
    return "high";
  }

  if (suggestedResources.length > 1) {
    return "medium";
  }

  return "low";
}

function buildExplanation(
  service: PolicySuggestion["service"],
  suggestedResources: PolicySuggestionResourceCandidate[]
): string {
  if (suggestedResources.length === 1) {
    return `The Lambda function references one ${service} resource, so Resource "*" can likely be narrowed to that resource.`;
  }

  if (suggestedResources.length > 1) {
    return `The Lambda function references multiple ${service} resources, so Resource "*" may be narrowed to one or more of those resources after review.`;
  }

  return `The policy grants ${service} permissions on Resource "*", but the template does not show a referenced ${service} resource for this Lambda.`;
}

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
