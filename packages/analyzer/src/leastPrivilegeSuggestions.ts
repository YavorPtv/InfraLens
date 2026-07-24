import type {
  CfnTemplate,
  CfnValue,
  PolicySuggestion,
  PolicySuggestionConfidence,
  PolicySuggestionResourceCandidate,
  PolicySuggestionSourceActionEvidence
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
import type { SourceCodeActionInference } from "./sourceCodeAnalysis";

export interface GenerateLeastPrivilegeResourceSuggestionsOptions {
  sourceActionInferences?: SourceCodeActionInference[];
}

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
  template: CfnTemplate,
  options: GenerateLeastPrivilegeResourceSuggestionsOptions = {}
): PolicySuggestion[] {
  return Object.entries(template.Resources).flatMap(([resourceId, resource]) => {
    if (resource.Type !== "AWS::Lambda::Function") {
      return [];
    }

    const lambdaRole = findLambdaExecutionRole(template, resourceId);
    if (lambdaRole === undefined) {
      return [];
    }

    return generateSuggestionsForLambdaRole(template, lambdaRole, options.sourceActionInferences ?? []);
  });
}

function generateSuggestionsForLambdaRole(
  template: CfnTemplate,
  lambdaRole: LambdaRoleLookup,
  sourceActionInferences: SourceCodeActionInference[]
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
        evidencePath,
        sourceActionInferences
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
  statementEvidencePath: string,
  sourceActionInferences: SourceCodeActionInference[]
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

    const sourceActions = findSourceActionsForService(
      sourceActionInferences,
      service.service,
      matchingActions
    );
    const suggestedActions =
      sourceActions.length > 0 ? sourceActions.map((sourceAction) => sourceAction.action) : matchingActions;

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
        actions: suggestedActions,
        currentResource: statement.Resource,
        confidence: getConfidence(suggestedResources, sourceActions),
        suggestedResources,
        explanation: buildExplanation(service.service, suggestedResources, sourceActions),
        evidence: {
          lambdaFunctionId: lambdaRole.lambdaFunctionId,
          lambdaRoleEvidencePath: lambdaRole.evidencePath,
          policyEvidencePath: policy.policyEvidencePath,
          statementEvidencePath,
          inferredResources: suggestedResources,
          ...(sourceActions.length === 0 ? {} : { sourceActions })
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

function findSourceActionsForService(
  sourceActionInferences: SourceCodeActionInference[],
  service: PolicySuggestion["service"],
  policyActions: string[]
): PolicySuggestionSourceActionEvidence[] {
  const sourceActionsByAction = new Map<string, PolicySuggestionSourceActionEvidence>();

  for (const inference of sourceActionInferences) {
    if (
      !isActionForService(inference.action, service) ||
      !policyActions.some((policyAction) => actionCovers(policyAction, inference.action)) ||
      sourceActionsByAction.has(inference.action)
    ) {
      continue;
    }

    sourceActionsByAction.set(inference.action, {
      action: inference.action,
      filePath: inference.filePath,
      matchedCommand: inference.matchedCommand
    });
  }

  return [...sourceActionsByAction.values()];
}

function actionCovers(policyAction: string, inferredAction: string): boolean {
  const normalizedPolicyAction = policyAction.toLowerCase();
  const normalizedInferredAction = inferredAction.toLowerCase();

  if (normalizedPolicyAction === normalizedInferredAction) {
    return true;
  }

  if (normalizedPolicyAction.endsWith(":*")) {
    return normalizedInferredAction.startsWith(normalizedPolicyAction.slice(0, -1));
  }

  return false;
}

function isWildcardResource(resource: CfnValue | undefined): resource is CfnValue {
  if (resource === "*") {
    return true;
  }

  return Array.isArray(resource) && resource.some((item) => item === "*");
}

function getConfidence(
  suggestedResources: PolicySuggestionResourceCandidate[],
  sourceActions: PolicySuggestionSourceActionEvidence[]
): PolicySuggestionConfidence {
  if (suggestedResources.length === 1 && sourceActions.length > 0) {
    return "high";
  }

  if (suggestedResources.length > 0) {
    return "medium";
  }

  return "low";
}

function buildExplanation(
  service: PolicySuggestion["service"],
  suggestedResources: PolicySuggestionResourceCandidate[],
  sourceActions: PolicySuggestionSourceActionEvidence[]
): string {
  if (suggestedResources.length === 1 && sourceActions.length > 0) {
    return `The Lambda function references one ${service} resource, and source code uses exact ${service} SDK commands, so both Action and Resource can likely be narrowed.`;
  }

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
