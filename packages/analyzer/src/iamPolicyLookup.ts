import type { CfnResource, CfnTemplate, CfnValue } from "@infralens/shared";
import { extractResourceReferences, type ResourceReference } from "./resourceReferences";

export interface LambdaRoleLookup {
  lambdaFunctionId: string;
  lambdaFunction: CfnResource;
  roleId: string;
  role: CfnResource;
  evidencePath: string;
}

export interface InlineRolePolicyLookup {
  roleId: string;
  role: CfnResource;
  policyName?: string;
  policyDocument?: CfnValue;
  evidencePath: string;
}

export interface AttachedPolicyResourceLookup {
  roleId: string;
  role: CfnResource;
  policyResourceId: string;
  policyResource: CfnResource;
  policyName?: string;
  policyDocument?: CfnValue;
  roleReference: ResourceReference;
  evidencePath: string;
}

export function findLambdaExecutionRole(
  template: CfnTemplate,
  lambdaFunctionId: string
): LambdaRoleLookup | undefined {
  const lambdaFunction = template.Resources[lambdaFunctionId];
  if (lambdaFunction?.Type !== "AWS::Lambda::Function") {
    return undefined;
  }

  const roleReferences = extractResourceReferences(
    lambdaFunction.Properties?.Role,
    `Resources.${lambdaFunctionId}.Properties.Role`
  );
  const roleReference = roleReferences.find((reference) =>
    isResourceType(template, reference.resourceId, "AWS::IAM::Role")
  );

  if (roleReference === undefined) {
    return undefined;
  }

  return {
    lambdaFunctionId,
    lambdaFunction,
    roleId: roleReference.resourceId,
    role: template.Resources[roleReference.resourceId],
    evidencePath: roleReference.evidencePath
  };
}

export function findRoleInlinePolicies(
  template: CfnTemplate,
  roleId: string
): InlineRolePolicyLookup[] {
  const role = template.Resources[roleId];
  if (role?.Type !== "AWS::IAM::Role" || !Array.isArray(role.Properties?.Policies)) {
    return [];
  }

  return role.Properties.Policies.flatMap((policy, policyIndex) => {
    if (!isRecord(policy)) {
      return [];
    }

    return [
      {
        roleId,
        role,
        policyName: typeof policy.PolicyName === "string" ? policy.PolicyName : undefined,
        policyDocument: policy.PolicyDocument,
        evidencePath: `Resources.${roleId}.Properties.Policies[${policyIndex}]`
      }
    ];
  });
}

export function findPolicyResourcesAttachedToRole(
  template: CfnTemplate,
  roleId: string
): AttachedPolicyResourceLookup[] {
  const role = template.Resources[roleId];
  if (role?.Type !== "AWS::IAM::Role") {
    return [];
  }

  return Object.entries(template.Resources).flatMap(([policyResourceId, policyResource]) => {
    if (policyResource.Type !== "AWS::IAM::Policy") {
      return [];
    }

    return findRoleReferencesInPolicyResource(
      template,
      roleId,
      role,
      policyResourceId,
      policyResource
    ).map((roleReference) => ({
        roleId,
        role,
        policyResourceId,
        policyResource,
        policyName:
          typeof policyResource.Properties?.PolicyName === "string"
            ? policyResource.Properties.PolicyName
            : undefined,
        policyDocument: policyResource.Properties?.PolicyDocument,
        roleReference,
        evidencePath: `Resources.${policyResourceId}`
      }));
  });
}

function findRoleReferencesInPolicyResource(
  template: CfnTemplate,
  roleId: string,
  role: CfnResource,
  policyResourceId: string,
  policyResource: CfnResource
): ResourceReference[] {
  const roles = policyResource.Properties?.Roles;
  const rolesPath = `Resources.${policyResourceId}.Properties.Roles`;
  const roleReferences = extractResourceReferences(roles, rolesPath).filter(
    (reference) =>
      reference.resourceId === roleId &&
      isResourceType(template, reference.resourceId, "AWS::IAM::Role")
  );

  if (Array.isArray(roles)) {
    return [
      ...roleReferences,
      ...roles.flatMap((roleValue, index) =>
        isLiteralRoleNameMatch(roleId, role, roleValue)
          ? [
              {
                resourceId: roleId,
                evidencePath: `${rolesPath}[${index}]`
              }
            ]
          : []
      )
    ];
  }

  return roleReferences;
}

function isLiteralRoleNameMatch(roleId: string, role: CfnResource, value: CfnValue): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return value === roleId || value === role.Properties?.RoleName;
}

function isResourceType(template: CfnTemplate, resourceId: string, type: string): boolean {
  return template.Resources[resourceId]?.Type === type;
}

function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
