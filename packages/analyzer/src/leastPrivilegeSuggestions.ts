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
import {
  awsServiceMetadata,
  getActionMetadata,
  type AwsServiceMetadata,
  type IamResourceForm
} from "./serviceMetadata";
import type { SourceCodeActionInference } from "./sourceCodeAnalysis";

export interface GenerateLeastPrivilegeResourceSuggestionsOptions {
  sourceActionInferences?: SourceCodeActionInference[];
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

  const statementServices = new Set(
    actions.flatMap((action) => {
      const separatorIndex = action.indexOf(":");
      return separatorIndex === -1 ? [] : [action.slice(0, separatorIndex).toLowerCase()];
    })
  );
  const isMixedServiceStatement = statementServices.size > 1;

  return awsServiceMetadata.flatMap((service) => {
    const matchingActions = actions.filter((action) => isActionForService(action, service.service));
    if (matchingActions.length === 0) {
      return [];
    }

    const sourceActions = findSourceActionsForService(
      sourceActionInferences,
      lambdaRole.lambdaFunctionId,
      service.service,
      matchingActions
    );
    const suggestedActions =
      sourceActions.length > 0 ? sourceActions.map((sourceAction) => sourceAction.action) : matchingActions;
    const canNarrowActions =
      sourceActions.length > 0 &&
      sourceActions.every(
        (sourceAction) =>
          sourceAction.confidence === "high" && sourceAction.actionConfidence === "high"
      );
    const sourceActionReviewRequired =
      sourceActions.length > 0 &&
      !canNarrowActions &&
      !haveSameActions(suggestedActions, matchingActions);
    const resourceActions = sourceActions.length > 0 ? suggestedActions : matchingActions;
    const resourceResolution = findReferencedResourceCandidates(
      template,
      lambdaReferences,
      service,
      resourceActions
    );
    const suggestedResources = resourceResolution.candidates;
    const manualReviewReason = getManualReviewReason({
      service,
      isMixedServiceStatement,
      sourceActionReviewRequired,
      suggestedResources,
      resourceResolutionReason: resourceResolution.reason
    });

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
        currentActions: matchingActions,
        suggestedActions,
        actions: suggestedActions,
        currentResource: statement.Resource,
        confidence: getConfidence(suggestedResources, sourceActions),
        suggestedResources,
        explanation: buildExplanation(
          service.service,
          suggestedResources,
          sourceActions,
          manualReviewReason
        ),
        ...(manualReviewReason === undefined
          ? {}
          : { manualOnly: true, manualReviewReason }),
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
  service: AwsServiceMetadata,
  actions: string[]
): { candidates: PolicySuggestionResourceCandidate[]; reason?: string } {
  const actionMetadata = actions.map((action) => getActionMetadata(action));
  if (actionMetadata.some((metadata) => metadata === undefined)) {
    return {
      candidates: [],
      reason: "InfraLens does not have resource-compatibility metadata for every action that would remain in this statement."
    };
  }

  const knownActions = actionMetadata.filter(
    (metadata): metadata is NonNullable<typeof metadata> => metadata !== undefined
  );
  if (knownActions.some((metadata) => metadata.resourceScope === "wildcard")) {
    return {
      candidates: [],
      reason: "At least one action requires Resource \"*\" and cannot be narrowed to a resource ARN."
    };
  }

  if (knownActions.some((metadata) => metadata.resourceScope === "manual")) {
    return {
      candidates: [],
      reason: "At least one action requires service-specific manual resource review."
    };
  }

  const resourceTypes = unique(
    knownActions.flatMap((metadata) =>
      metadata.resourceType === undefined ? [] : [metadata.resourceType]
    )
  );
  if (resourceTypes.length !== 1) {
    return {
      candidates: [],
      reason: "The actions do not share one compatible CloudFormation resource type."
    };
  }

  const resourceMetadata = service.resources.find(
    (metadata) => metadata.resourceType === resourceTypes[0]
  );
  if (resourceMetadata === undefined) {
    return {
      candidates: [],
      reason: "InfraLens cannot construct a resource for these actions."
    };
  }

  const resourceForms = unique(
    knownActions.flatMap((metadata) =>
      metadata.resourceForm === undefined ? [] : [metadata.resourceForm]
    )
  ) as IamResourceForm[];
  const candidatesById = new Map<string, PolicySuggestionResourceCandidate>();

  for (const reference of references) {
    const resource = template.Resources[reference.resourceId];
    if (resource?.Type !== resourceMetadata.resourceType || candidatesById.has(reference.resourceId)) {
      continue;
    }

    const suggestedResource = resourceMetadata.suggestedResourceFor(
      reference.resourceId,
      resource,
      resourceForms
    );
    if (suggestedResource === undefined) {
      continue;
    }

    candidatesById.set(reference.resourceId, {
      resourceId: reference.resourceId,
      resourceType: resource.Type,
      referenceEvidencePath: reference.evidencePath,
      suggestedResource
    });
  }

  const candidates = [...candidatesById.values()];
  return candidates.length === 0
    ? {
        candidates,
        reason: `The template does not show a safely representable referenced ${service.service} resource for this Lambda.`
      }
    : { candidates };
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
  lambdaFunctionId: string,
  service: PolicySuggestion["service"],
  policyActions: string[]
): PolicySuggestionSourceActionEvidence[] {
  const sourceActionsByAction = new Map<string, PolicySuggestionSourceActionEvidence>();

  for (const inference of sourceActionInferences) {
    if (
      inference.lambdaFunctionId !== lambdaFunctionId ||
      !isActionForService(inference.action, service) ||
      !policyActions.some((policyAction) => actionCovers(policyAction, inference.action)) ||
      sourceActionsByAction.has(inference.action)
    ) {
      continue;
    }

    sourceActionsByAction.set(inference.action, {
      action: inference.action,
      filePath: inference.filePath,
      lambdaFunctionId: inference.lambdaFunctionId,
      ...(inference.rootFilePath === undefined
        ? {}
        : { rootFilePath: inference.rootFilePath }),
      ...(inference.importChain === undefined ? {} : { importChain: inference.importChain }),
      matchedCommand: inference.matchedCommand,
      confidence: inference.confidence,
      ...(inference.actionConfidence === undefined
        ? {}
        : { actionConfidence: inference.actionConfidence }),
      ...(inference.sdkPackage === undefined ? {} : { sdkPackage: inference.sdkPackage }),
      evidence: inference.evidence
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
  if (
    suggestedResources.length === 1 &&
    sourceActions.length > 0 &&
    sourceActions.every(
      (sourceAction) =>
        sourceAction.confidence === "high" && sourceAction.actionConfidence === "high"
    )
  ) {
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
  sourceActions: PolicySuggestionSourceActionEvidence[],
  manualReviewReason?: string
): string {
  if (manualReviewReason !== undefined) {
    return `The policy grants ${service} permissions on Resource "*". ${manualReviewReason}`;
  }

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

function getManualReviewReason(input: {
  service: AwsServiceMetadata;
  isMixedServiceStatement: boolean;
  sourceActionReviewRequired: boolean;
  suggestedResources: PolicySuggestionResourceCandidate[];
  resourceResolutionReason?: string;
}): string | undefined {
  if (input.isMixedServiceStatement) {
    return "This statement contains actions from multiple AWS services and must be split or reviewed as a whole.";
  }

  if (input.service.manualOnly) {
    return input.service.manualOnlyReason;
  }

  if (input.sourceActionReviewRequired) {
    return "Source command-package evidence or Lambda mapping evidence is not high confidence, so action narrowing requires manual review.";
  }

  if (input.resourceResolutionReason !== undefined) {
    return input.resourceResolutionReason;
  }

  if (input.suggestedResources.length > 1) {
    return "Multiple compatible resources are referenced, so InfraLens cannot choose one automatically.";
  }

  return undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function haveSameActions(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left.map((action) => action.toLowerCase()))].sort();
  const normalizedRight = [...new Set(right.map((action) => action.toLowerCase()))].sort();

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((action, index) => action === normalizedRight[index])
  );
}

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
