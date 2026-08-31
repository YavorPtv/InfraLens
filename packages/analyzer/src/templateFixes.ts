import type {
  ApplyFixResult,
  ApplySuggestionsResult,
  CfnResource,
  CfnTemplate,
  CfnValue,
  Finding,
  PolicySuggestion,
  TemplateFix,
  TemplatePatch,
  TemplatePathSegment
} from "@infralens/shared";

const blockedPathSegments = new Set(["__proto__", "constructor", "prototype"]);

export function applyTemplateFixes(
  originalTemplate: CfnTemplate,
  selectedFixes: TemplateFix[]
): ApplySuggestionsResult {
  let modifiedTemplate = cloneTemplate(originalTemplate);
  const conflicts = findConflictingFixes(selectedFixes);
  const results: ApplyFixResult[] = [];

  for (const fix of selectedFixes) {
    if (fix.applicability !== "applicable" || fix.patches.length === 0) {
      results.push(failedResult(fix, "This suggestion requires manual review and has no safe patch."));
      continue;
    }

    if (conflicts.has(fix.id)) {
      results.push(failedResult(fix, "This fix conflicts with another selected fix at the same target path."));
      continue;
    }

    const candidateTemplate = cloneTemplate(modifiedTemplate);
    const failure = applyFix(candidateTemplate, fix);

    if (failure !== undefined) {
      results.push(failedResult(fix, failure));
      continue;
    }

    modifiedTemplate = candidateTemplate;
    results.push({
      fixId: fix.id,
      status: "applied",
      message: `Applied ${fix.patches.length} template patch${fix.patches.length === 1 ? "" : "es"}.`
    });
  }

  const appliedFixCount = results.filter((result) => result.status === "applied").length;

  return {
    modifiedTemplate,
    appliedFixCount,
    failedFixCount: results.length - appliedFixCount,
    results
  };
}

export function generateFindingTemplateFixes(
  template: CfnTemplate,
  findings: Finding[]
): TemplateFix[] {
  return findings.map((finding) => createFindingFix(template, finding));
}

export function generateLeastPrivilegeTemplateFixes(
  template: CfnTemplate,
  suggestions: PolicySuggestion[]
): TemplateFix[] {
  return suggestions.map((suggestion) => {
    const targetResourceId = suggestion.policyResourceId ?? suggestion.roleId;
    const targetResourceType =
      suggestion.policySourceType === "policy-resource"
        ? "AWS::IAM::Policy"
        : "AWS::IAM::Role";
    const statementPath = parseResourcePath(
      suggestion.evidence.statementEvidencePath,
      targetResourceId
    );

    if (statementPath === undefined) {
      return createManualLeastPrivilegeFix(
        suggestion,
        targetResourceId,
        targetResourceType,
        `Narrow ${suggestion.service} access for ${suggestion.roleId}`
      );
    }

    return createLeastPrivilegeTemplateFix(
      template,
      suggestion,
      targetResourceId,
      targetResourceType,
      statementPath
    );
  });
}

export function createLeastPrivilegeTemplateFix(
  template: CfnTemplate,
  suggestion: PolicySuggestion,
  targetResourceId: string,
  targetResourceType: string,
  statementPath: TemplatePathSegment[]
): TemplateFix {
  const statement = getValueAtResourcePath(template, targetResourceId, statementPath);
  const title = `Narrow ${suggestion.service} access for ${suggestion.roleId}`;
  const manualFix = createManualLeastPrivilegeFix(
    suggestion,
    targetResourceId,
    targetResourceType,
    title
  );

  if (!isRecord(statement) || suggestion.suggestedResources.length !== 1) {
    return manualFix;
  }

  const statementActions = getStringValues(statement.Action);
  if (
    statement.Resource !== "*" ||
    statementActions.length === 0 ||
    !statementActions.every((action) => action.toLowerCase().startsWith(`${suggestion.service}:`))
  ) {
    return manualFix;
  }

  const patches: TemplatePatch[] = [
    {
      targetResourceId,
      targetResourceType,
      path: [...statementPath, "Resource"],
      operation: "set",
      value: suggestion.suggestedResources[0].suggestedResource,
      allowCreate: false,
      expectedValue: "*"
    }
  ];
  const hasExactSourceActions =
    suggestion.confidence === "high" &&
    (suggestion.evidence.sourceActions?.length ?? 0) > 0 &&
    suggestion.evidence.sourceActions?.every((sourceAction) => sourceAction.confidence === "high") ===
      true &&
    suggestion.suggestedActions.length > 0;

  if (hasExactSourceActions) {
    patches.push({
      targetResourceId,
      targetResourceType,
      path: [...statementPath, "Action"],
      operation: "set",
      value:
        suggestion.suggestedActions.length === 1
          ? suggestion.suggestedActions[0]
          : suggestion.suggestedActions,
      allowCreate: false,
      expectedValue: statement.Action
    });
  }

  return {
    ...manualFix,
    applicability: "applicable",
    explanation: hasExactSourceActions
      ? `${suggestion.explanation} This fix replaces both Resource and Action with the concrete inferred values.`
      : `${suggestion.explanation} This fix replaces only Resource; existing actions are preserved.`,
    patches
  };
}

function createFindingFix(template: CfnTemplate, finding: Finding): TemplateFix {
  const resource = template.Resources[finding.resourceId];
  const resourceType = resource?.Type ?? "Unknown";
  const baseFix: Omit<TemplateFix, "applicability" | "confidence" | "patches"> = {
    id: `finding:${finding.ruleId}:${finding.resourceId}:${finding.evidencePath}`,
    title: finding.title,
    targetResourceId: finding.resourceId,
    targetResourceType: resourceType,
    explanation: finding.suggestion,
    source: {
      kind: "finding",
      ruleId: finding.ruleId,
      evidencePath: finding.evidencePath
    }
  };

  if (resource === undefined) {
    return {
      ...baseFix,
      applicability: "manual-review",
      confidence: "low",
      patches: []
    };
  }

  if (finding.ruleId === "S3_PUBLIC_ACCESS_BLOCK_MISSING") {
    const settingNames = [
      "BlockPublicAcls",
      "BlockPublicPolicy",
      "IgnorePublicAcls",
      "RestrictPublicBuckets"
    ];

    return {
      ...baseFix,
      applicability: "applicable",
      confidence: "high",
      patches: settingNames.map((settingName) => ({
        targetResourceId: finding.resourceId,
        targetResourceType: "AWS::S3::Bucket",
        path: ["Properties", "PublicAccessBlockConfiguration", settingName],
        operation: "set",
        value: true,
        allowCreate: true
      }))
    };
  }

  if (finding.ruleId === "DYNAMODB_MISSING_PITR") {
    return {
      ...baseFix,
      applicability: "applicable",
      confidence: "high",
      patches: [
        {
          targetResourceId: finding.resourceId,
          targetResourceType: "AWS::DynamoDB::Table",
          path: [
            "Properties",
            "PointInTimeRecoverySpecification",
            "PointInTimeRecoveryEnabled"
          ],
          operation: "set",
          value: true,
          allowCreate: true
        }
      ]
    };
  }

  return {
    ...baseFix,
    applicability: "manual-review",
    confidence: finding.ruleId === "LOG_GROUP_MISSING_RETENTION" ? "medium" : "low",
    patches: []
  };
}

function createManualLeastPrivilegeFix(
  suggestion: PolicySuggestion,
  targetResourceId: string,
  targetResourceType: string,
  title: string
): TemplateFix {
  return {
    id: `least-privilege:${suggestion.lambdaFunctionId}:${targetResourceId}:${suggestion.evidence.statementEvidencePath}:${suggestion.service}`,
    title,
    targetResourceId,
    targetResourceType,
    applicability: "manual-review",
    confidence: suggestion.confidence,
    explanation: `${suggestion.explanation} An exact safe replacement is not available for this statement.`,
    source: {
      kind: "least-privilege",
      lambdaFunctionId: suggestion.lambdaFunctionId,
      roleId: suggestion.roleId,
      evidencePath: suggestion.evidence.statementEvidencePath
    },
    patches: []
  };
}

function applyFix(template: CfnTemplate, fix: TemplateFix): string | undefined {
  for (const patch of fix.patches) {
    if (
      patch.targetResourceId !== fix.targetResourceId ||
      patch.targetResourceType !== fix.targetResourceType
    ) {
      return "A patch target does not match its parent fix target.";
    }

    const failure = applyPatch(template, patch);
    if (failure !== undefined) {
      return failure;
    }
  }

  return undefined;
}

function applyPatch(template: CfnTemplate, patch: TemplatePatch): string | undefined {
  const resource = template.Resources[patch.targetResourceId];
  if (resource === undefined) {
    return `Resource ${patch.targetResourceId} does not exist.`;
  }

  if (resource.Type !== patch.targetResourceType) {
    return `Resource ${patch.targetResourceId} has type ${resource.Type}, expected ${patch.targetResourceType}.`;
  }

  const pathError = validatePath(patch.path);
  if (pathError !== undefined) {
    return pathError;
  }

  let parent: CfnResource | Record<string, CfnValue> | CfnValue[] = resource;

  for (let index = 0; index < patch.path.length - 1; index += 1) {
    const segment = patch.path[index];
    const nextSegment = patch.path[index + 1];
    const child = readChild(parent, segment);

    if (child === undefined) {
      if (!patch.allowCreate || typeof segment !== "string" || typeof nextSegment !== "string") {
        return `Target path ${formatPath(patch.path)} does not exist.`;
      }

      const created: Record<string, CfnValue> = {};
      writeChild(parent, segment, created);
      parent = created;
      continue;
    }

    if (!isContainer(child)) {
      return `Target path ${formatPath(patch.path)} crosses a non-container value.`;
    }

    parent = child;
  }

  const finalSegment = patch.path[patch.path.length - 1];
  const currentValue = readChild(parent, finalSegment);
  if (currentValue === undefined && !patch.allowCreate) {
    return `Target path ${formatPath(patch.path)} does not exist.`;
  }

  if (patch.expectedValue !== undefined && !deepEqual(currentValue, patch.expectedValue)) {
    return `Target path ${formatPath(patch.path)} no longer contains the expected value.`;
  }

  if (!canWriteChild(parent, finalSegment)) {
    return `Target path ${formatPath(patch.path)} is invalid.`;
  }

  writeChild(parent, finalSegment, cloneValue(patch.value));
  return undefined;
}

function findConflictingFixes(fixes: TemplateFix[]): Set<string> {
  const patchesByPath = new Map<string, Array<{ fixId: string; value: CfnValue }>>();

  for (const fix of fixes) {
    for (const patch of fix.patches) {
      const key = `${patch.targetResourceId}\u0000${JSON.stringify(patch.path)}`;
      const patches = patchesByPath.get(key) ?? [];
      patches.push({ fixId: fix.id, value: patch.value });
      patchesByPath.set(key, patches);
    }
  }

  const conflicts = new Set<string>();
  for (const patches of patchesByPath.values()) {
    if (patches.some((patch) => !deepEqual(patch.value, patches[0].value))) {
      patches.forEach((patch) => conflicts.add(patch.fixId));
    }
  }

  return conflicts;
}

function validatePath(path: TemplatePathSegment[]): string | undefined {
  if (path.length === 0 || path[0] !== "Properties") {
    return "Template patch paths must target a resource property.";
  }

  if (
    path.some(
      (segment) =>
        (typeof segment === "string" && blockedPathSegments.has(segment)) ||
        (typeof segment === "number" && (!Number.isInteger(segment) || segment < 0))
    )
  ) {
    return `Target path ${formatPath(path)} is invalid.`;
  }

  return undefined;
}

function getValueAtResourcePath(
  template: CfnTemplate,
  resourceId: string,
  path: TemplatePathSegment[]
): CfnValue | CfnResource | undefined {
  let current: CfnValue | CfnResource | undefined = template.Resources[resourceId];

  for (const segment of path) {
    if (!isContainer(current)) {
      return undefined;
    }
    current = readChild(current, segment);
  }

  return current;
}

function parseResourcePath(
  evidencePath: string,
  resourceId: string
): TemplatePathSegment[] | undefined {
  const prefix = `Resources.${resourceId}.`;
  if (!evidencePath.startsWith(prefix)) {
    return undefined;
  }

  const path: TemplatePathSegment[] = [];
  const relativePath = evidencePath.slice(prefix.length);
  const tokenPattern = /(?:^|\.)([^.[\]]+)|\[(\d+)\]/g;
  let consumedLength = 0;

  for (const match of relativePath.matchAll(tokenPattern)) {
    if (match.index !== consumedLength) {
      return undefined;
    }

    path.push(match[1] ?? Number(match[2]));
    consumedLength += match[0].length;
  }

  return consumedLength === relativePath.length && path.length > 0 ? path : undefined;
}

function readChild(
  parent: CfnResource | Record<string, CfnValue> | CfnValue[],
  segment: TemplatePathSegment
): CfnValue | undefined {
  if (Array.isArray(parent)) {
    return typeof segment === "number" ? parent[segment] : undefined;
  }

  return typeof segment === "string"
    ? (parent as unknown as Record<string, CfnValue>)[segment]
    : undefined;
}

function canWriteChild(
  parent: CfnResource | Record<string, CfnValue> | CfnValue[],
  segment: TemplatePathSegment
): boolean {
  return Array.isArray(parent)
    ? typeof segment === "number" && segment < parent.length
    : typeof segment === "string";
}

function writeChild(
  parent: CfnResource | Record<string, CfnValue> | CfnValue[],
  segment: TemplatePathSegment,
  value: CfnValue
): void {
  if (Array.isArray(parent) && typeof segment === "number") {
    parent[segment] = value;
  } else if (!Array.isArray(parent) && typeof segment === "string") {
    (parent as unknown as Record<string, CfnValue>)[segment] = value;
  }
}

function getStringValues(value: CfnValue | undefined): string[] {
  if (typeof value === "string") {
    return [value];
  }

  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isContainer(
  value: CfnValue | CfnResource | undefined
): value is CfnResource | Record<string, CfnValue> | CfnValue[] {
  return typeof value === "object" && value !== null;
}

function isRecord(value: CfnValue | CfnResource | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneTemplate(template: CfnTemplate): CfnTemplate {
  return JSON.parse(JSON.stringify(template)) as CfnTemplate;
}

function cloneValue(value: CfnValue): CfnValue {
  return JSON.parse(JSON.stringify(value)) as CfnValue;
}

function deepEqual(left: CfnValue | undefined, right: CfnValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatPath(path: TemplatePathSegment[]): string {
  return path.map((segment) => (typeof segment === "number" ? `[${segment}]` : segment)).join(".");
}

function failedResult(fix: TemplateFix, message: string): ApplyFixResult {
  return {
    fixId: fix.id,
    status: "failed",
    message
  };
}
