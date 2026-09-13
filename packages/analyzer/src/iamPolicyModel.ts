import type { CfnTemplate, CfnValue, IamAnalysis, IamManagedPolicyReference, IamPolicyDocument, IamStatementContext } from "@infralens/shared";
import { analyzeIamCondition, describeIamCondition, isRecord } from "./iamConditions";

export function buildIamAnalysis(template: CfnTemplate): IamAnalysis {
  const principals = Object.entries(template.Resources).flatMap(([resourceId, resource]) => {
    if (!["AWS::IAM::Role", "AWS::IAM::User", "AWS::IAM::Group"].includes(resource.Type)) return [];
    const path = `Resources.${resourceId}.Properties`;
    const arns = resource.Properties?.ManagedPolicyArns;
    return [{ resourceId, resourceType: resource.Type,
      managedPolicies: (Array.isArray(arns) ? arns : arns === undefined ? [] : [arns])
        .map((value, index) => resolveManagedPolicy(template, value, `${path}.ManagedPolicyArns${Array.isArray(arns) ? `[${index}]` : ""}`)),
      ...(resource.Properties?.PermissionsBoundary === undefined ? {} : {
        permissionsBoundary: resolveManagedPolicy(template, resource.Properties.PermissionsBoundary, `${path}.PermissionsBoundary`)
      })
    }];
  });
  const policies: IamPolicyDocument[] = [];
  for (const [resourceId, resource] of Object.entries(template.Resources)) {
    const path = `Resources.${resourceId}.Properties`;
    if (principals.some(principal => principal.resourceId === resourceId)) {
      const inline = resource.Properties?.Policies;
      if (Array.isArray(inline)) inline.forEach((policy, index) => {
        if (isRecord(policy)) policies.push({ resourceId, kind: "inline", document: policy.PolicyDocument,
          evidencePath: `${path}.Policies[${index}].PolicyDocument`, principalIds: [resourceId], boundaryFor: [] });
      });
    }
    if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::ManagedPolicy") continue;
    const principalIds = principals.filter(principal => {
      const suffix = principal.resourceType.split("::")[2];
      const attached = resource.Properties?.[`${suffix}s`];
      return (Array.isArray(attached) && attached.some(value => {
        const id = directResourceId(value);
        return id === principal.resourceId || (typeof value === "string" && value === template.Resources[principal.resourceId].Properties?.[`${suffix}Name`]);
      })) || principal.managedPolicies.some(reference => reference.policyResourceId === resourceId);
    }).map(principal => principal.resourceId);
    policies.push({ resourceId, kind: resource.Type === "AWS::IAM::Policy" ? "policy-resource" : "managed-policy-resource",
      document: resource.Properties?.PolicyDocument, evidencePath: `${path}.PolicyDocument`, principalIds,
      unresolvedAttachments: ["Role", "User", "Group"].flatMap(type => {
        const values = resource.Properties?.[`${type}s`];
        return (Array.isArray(values) ? values : values === undefined ? [] : [values]).flatMap((value, index) => {
          const matches = principals.some(principal => principal.resourceType === `AWS::IAM::${type}` &&
            (directResourceId(value) === principal.resourceId || (typeof value === "string" && value === template.Resources[principal.resourceId].Properties?.[`${type}Name`])));
          return matches ? [] : [{ value, evidencePath: `${path}.${type}s[${index}]` }];
        });
      }),
      boundaryFor: principals.filter(principal => principal.permissionsBoundary?.policyResourceId === resourceId).map(principal => principal.resourceId) });
  }
  const limitations = ["Identity policy statements are analyzed, not effective permissions. Resource policies, SCPs, session policies and full IAM evaluation are not implemented."];
  for (const policy of policies) {
    if (policyStatements(policy).length === 0) limitations.push(`${policy.evidencePath}: no statically inspectable statements were found.`);
    for (const location of policyStatements(policy)) {
      if (location.statement.NotAction !== undefined || location.statement.NotResource !== undefined) {
        limitations.push(`${location.evidencePath}: NotAction/NotResource complements are preserved but not evaluated.`);
      }
    }
  }
  for (const principal of principals) {
    for (const reference of principal.managedPolicies.filter(reference => reference.status === "unresolved")) {
      limitations.push(`${reference.evidencePath}: unresolved ${reference.policyResourceId ? "template-defined" : "external"} managed policy; contents were not inspected.`);
    }
    if (principal.permissionsBoundary) limitations.push(`${principal.permissionsBoundary.evidencePath}: ${principal.permissionsBoundary.status} permissions boundary; intersection with identity policies was not evaluated.`);
  }
  return { evaluation: "partial", principals, policies, limitations };
}

export function directResourceId(value: CfnValue | undefined): string | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  if (typeof value.Ref === "string") return value.Ref;
  const getAtt = value["Fn::GetAtt"];
  if (Array.isArray(getAtt) && getAtt.length === 2 && typeof getAtt[0] === "string") return getAtt[0];
  if (typeof getAtt === "string") return getAtt.split(".")[0];
  const sub = value["Fn::Sub"];
  return typeof sub === "string" ? /^\$\{([A-Za-z0-9]+)(?:\.Arn)?\}$/.exec(sub)?.[1] : undefined;
}

function resolveManagedPolicy(template: CfnTemplate, value: CfnValue, evidencePath: string): IamManagedPolicyReference {
  const id = directResourceId(value);
  const resource = id === undefined ? undefined : template.Resources[id];
  const local = resource?.Type === "AWS::IAM::ManagedPolicy";
  const document = resource?.Properties?.PolicyDocument;
  const inspectable = isRecord(document) && (isRecord(document.Statement) ||
    (Array.isArray(document.Statement) && document.Statement.some(isRecord)));
  return { value, evidencePath, status: local && inspectable ? "template-defined" : "unresolved",
    ...(local ? { policyResourceId: id } : {}) };
}

export function policyStatements(policy: IamPolicyDocument): Array<{ statement: Record<string, CfnValue>; evidencePath: string }> {
  if (!isRecord(policy.document)) return [];
  const statements = policy.document.Statement;
  if (Array.isArray(statements)) return statements.flatMap((statement, index) => isRecord(statement)
    ? [{ statement, evidencePath: `${policy.evidencePath}.Statement[${index}]` }] : []);
  return isRecord(statements) ? [{ statement: statements, evidencePath: `${policy.evidencePath}.Statement` }] : [];
}

export function iamStatementContext(template: CfnTemplate, evidencePath: string, statement: Record<string, CfnValue>, model = buildIamAnalysis(template)): IamStatementContext {
  const policy = model.policies.find(policy => policyStatements(policy).some(location => location.evidencePath === evidencePath));
  const principalIds = policy?.principalIds ?? [];
  const principals = model.principals.filter(principal => principalIds.includes(principal.resourceId));
  return {
    condition: analyzeIamCondition(statement.Condition), principalIds,
    ...(policy?.unresolvedAttachments?.length ? { unresolvedPolicyAttachments: policy.unresolvedAttachments.map(attachment => attachment.evidencePath) } : {}),
    boundaries: principals.flatMap(principal => principal.permissionsBoundary ? [principal.permissionsBoundary] : []),
    unresolvedManagedPolicies: principals.flatMap(principal => principal.managedPolicies.filter(reference => reference.status === "unresolved")),
    explicitDenyEvidencePaths: model.policies.filter(other => other === policy || other.principalIds.some(id => principalIds.includes(id)) || other.boundaryFor.some(id => principalIds.includes(id)))
      .flatMap(policyStatements).filter(location => location.statement.Effect === "Deny").map(location => location.evidencePath),
    partial: true
  };
}

export function describeIamContext(context: IamStatementContext): string {
  return [describeIamCondition(context.condition),
    ...(context.unresolvedPolicyAttachments?.length ? [`Policy attachments at ${context.unresolvedPolicyAttachments.join(", ")} refer to identities InfraLens cannot resolve; their permissions must also be reviewed.`] : []),
    ...(context.principalIds.length ? [`Associated template identities: ${context.principalIds.join(", ")}.`] : []),
    ...context.boundaries.map(boundary => `A ${boundary.status} permissions boundary at ${boundary.evidencePath} limits identity-policy permissions; InfraLens has not evaluated its effect.`),
    ...context.unresolvedManagedPolicies.map(policy => `Unresolved ${policy.policyResourceId ? "template-defined" : "external"} managed policy at ${policy.evidencePath}; its contents are unknown.`),
    ...(context.explicitDenyEvidencePaths.length ? [`Explicit Deny statements at ${context.explicitDenyEvidencePaths.join(", ")} may override Allows; overlap was not evaluated.`] : []),
    "This is statement-level policy evidence, not proof of effective access."
  ].filter(Boolean).join(" ");
}

export function hasIamModifiers(context: IamStatementContext): boolean {
  return context.condition.status !== "none" || context.boundaries.length > 0 || context.unresolvedManagedPolicies.length > 0 || context.explicitDenyEvidencePaths.length > 0 || (context.unresolvedPolicyAttachments?.length ?? 0) > 0;
}
