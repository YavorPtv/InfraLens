import type { CfnResource, CfnTemplate, CfnValue, ResourceNode, TemplateValidationResult, ValidationIssue } from "@infralens/shared";
import { LineCounter, parseDocument, type CollectionTag, type ScalarTag } from "yaml";

export class TemplateValidationError extends Error {
  readonly analysisStatus = "not-run" as const;
  constructor(readonly validation: TemplateValidationResult) {
    super(validation.issues.map(issue => issue.message).join("; "));
    this.name = "TemplateValidationError";
  }
}

export function validateTemplate(rawTemplate: string): { validation: TemplateValidationResult; template?: CfnTemplate } {
  const validation: TemplateValidationResult = {
    parse: "not-run", structure: "not-run", cloudFormation: "not-run", issues: []
  };
  let parsed: unknown;
  try {
    parsed = parseCloudFormationInput(rawTemplate);
  } catch (error) {
    validation.parse = "invalid";
    validation.issues.push({ stage: "parse", code: "TEMPLATE_PARSE_ERROR", severity: "error",
      message: error instanceof Error ? error.message : "Invalid CloudFormation template input." });
    return { validation };
  }
  validation.parse = "valid";
  validation.issues = validateTemplateStructure(parsed);
  validation.structure = validation.issues.length === 0 ? "valid" : "invalid";
  return validation.structure === "valid"
    ? { validation, template: parsed as CfnTemplate } : { validation };
}

export function parseTemplateInput(rawTemplate: string): CfnTemplate {
  const result = validateTemplate(rawTemplate);
  if (result.template === undefined) throw new TemplateValidationError(result.validation);
  return result.template;
}

/** Shape checks only; resource property schemas and deployment semantics belong to other layers. */
export function validateTemplateStructure(template: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  function issue(path: string, message: string) {
    issues.push({ stage: "structure", code: "TEMPLATE_STRUCTURE_ERROR", severity: "error", path,
      message: "Invalid CloudFormation template: " + message });
  }
  if (!isRecord(template)) {
    issue("$", "expected a template object.");
    return issues;
  }
  const valueIssue = findUnsupportedValue(template);
  if (valueIssue !== undefined) {
    issue(valueIssue.path, valueIssue.message);
    return issues;
  }
  if (!isRecord(template.Resources)) issue("Resources", "missing Resources object.");
  else for (const [id, resource] of Object.entries(template.Resources)) {
    const path = "Resources." + id;
    if (!isRecord(resource)) { issue(path, "resource must be an object."); continue; }
    if (typeof resource.Type !== "string" || resource.Type.trim().length === 0)
      issue(path + ".Type", "resource must contain a non-empty Type string.");
    for (const key of ["Properties", "Metadata", "CreationPolicy", "UpdatePolicy"])
      if (resource[key] !== undefined && !isRecord(resource[key])) issue(path + "." + key, key + " must be an object.");
    if (resource.DependsOn !== undefined && !(typeof resource.DependsOn === "string" && resource.DependsOn.trim()) &&
        !(Array.isArray(resource.DependsOn) && resource.DependsOn.every(v => typeof v === "string" && v.trim())))
      issue(path + ".DependsOn", "DependsOn must be a logical ID or an array of logical IDs.");
    for (const key of ["Condition", "DeletionPolicy", "UpdateReplacePolicy"])
      if (resource[key] !== undefined && (typeof resource[key] !== "string" || !(resource[key] as string).trim()))
        issue(path + "." + key, key + " must be a non-empty string.");
  }
  for (const key of ["Metadata", "Parameters", "Mappings", "Conditions", "Outputs"])
    if (template[key] !== undefined && !isRecord(template[key])) issue(key, key + " must be an object.");
  for (const key of ["Description", "AWSTemplateFormatVersion"])
    if (template[key] !== undefined && typeof template[key] !== "string") issue(key, key + " must be a string.");
  const transform = template.Transform;
  if (transform !== undefined && !(typeof transform === "string" && transform.trim()) &&
      !(Array.isArray(transform) && transform.length > 0 && transform.every(v => typeof v === "string" && v.trim())))
    issue("Transform", "Transform must be a non-empty string or array of strings.");
  for (const section of ["Parameters", "Outputs"]) {
    const entries = template[section];
    if (!isRecord(entries)) continue;
    for (const [id, entry] of Object.entries(entries)) {
      if (!isRecord(entry)) { issue(section + "." + id, "section entry must be an object."); continue; }
      if (section === "Parameters" && (typeof entry.Type !== "string" || !entry.Type.trim()))
        issue(section + "." + id + ".Type", "parameter must contain a non-empty Type string.");
      if (section === "Outputs" && !("Value" in entry)) issue(section + "." + id, "output must contain Value.");
    }
  }
  return issues;
}

export function parseTemplate(rawTemplate: string): ResourceNode[] {
  const cfnTemplate = parseTemplateInput(rawTemplate);

  return templateToResourceNodes(cfnTemplate);
}

export function templateToResourceNodes(cfnTemplate: CfnTemplate): ResourceNode[] {
  const issues = validateTemplateStructure(cfnTemplate);
  if (issues.length) throw new TemplateValidationError({ parse: "valid", structure: "invalid", cloudFormation: "not-run", issues });

  return Object.entries(cfnTemplate.Resources).map(([logicalId, resource]) =>
    toResourceNode(logicalId, resource)
  );
}

function parseCloudFormationInput(rawTemplate: string): unknown {
  const trimmedTemplate = rawTemplate.trim();

  if (trimmedTemplate.length === 0) {
    throw new Error("Invalid CloudFormation template input: template is empty.");
  }

  try {
    return JSON.parse(rawTemplate) as unknown;
  } catch {
    return parseYaml(rawTemplate);
  }
}

function parseYaml(rawTemplate: string): unknown {
  const lineCounter = new LineCounter();
  const document = parseDocument(rawTemplate, {
    prettyErrors: false,
    lineCounter,
    customTags: createCloudFormationYamlTags()
  });

  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(
      `Invalid CloudFormation template input: ${[...document.errors, ...document.warnings]
        .map((error) => {
          const position = lineCounter.linePos(error.pos[0]);
          return `${error.message} (line ${position.line}, column ${position.col})`;
        })
        .join("; ")}`
    );
  }

  return document.toJS({
    maxAliasCount: 100
  }) as unknown;
}

// YAML aliases can produce cycles and non-finite numbers have no JSON representation.
// Bound nesting before the analyzer's recursive reference traversal starts.
function findUnsupportedValue(
  value: unknown,
  path = "$",
  ancestors = new Set<object>(),
  depth = 0
): { path: string; message: string } | undefined {
  if (depth > 100) return { path, message: "template nesting exceeds the local limit of 100 levels." };
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { path, message: "numeric values must be finite." };
  }
  if (value === null || typeof value !== "object") return undefined;
  if (ancestors.has(value)) return { path, message: "cyclic YAML aliases are not supported." };
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    const issue = findUnsupportedValue(child, `${path}.${key}`, ancestors, depth + 1);
    if (issue !== undefined) return issue;
  }
  ancestors.delete(value);
  return undefined;
}

function toResourceNode(logicalId: string, resource: CfnResource): ResourceNode {
  return {
    id: logicalId,
    type: resource.Type,
    properties: resource.Properties ?? {}
  };
}

function createCloudFormationYamlTags(): Array<ScalarTag | CollectionTag> {
  const intrinsicTags: Array<[string, string]> = [
    ["!And", "Fn::And"],
    ["!Base64", "Fn::Base64"],
    ["!Condition", "Condition"],
    ["!Equals", "Fn::Equals"],
    ["!FindInMap", "Fn::FindInMap"],
    ["!GetAtt", "Fn::GetAtt"],
    ["!GetAZs", "Fn::GetAZs"],
    ["!If", "Fn::If"],
    ["!ImportValue", "Fn::ImportValue"],
    ["!Join", "Fn::Join"],
    ["!Not", "Fn::Not"],
    ["!Or", "Fn::Or"],
    ["!Ref", "Ref"],
    ["!Select", "Fn::Select"],
    ["!Split", "Fn::Split"],
    ["!Sub", "Fn::Sub"]
  ];

  return intrinsicTags.flatMap(([tag, intrinsicName]) => [
    createScalarTag(tag, intrinsicName),
    createCollectionTag(tag, intrinsicName, "seq"),
    createCollectionTag(tag, intrinsicName, "map")
  ]);
}

function createScalarTag(tag: string, intrinsicName: string): ScalarTag {
  return {
    tag,
    resolve(value) {
      return {
        [intrinsicName]: value
      };
    }
  };
}

function createCollectionTag(
  tag: string,
  intrinsicName: string,
  collection: "map" | "seq"
): CollectionTag {
  return {
    tag,
    collection,
    resolve(value) {
      return {
        [intrinsicName]: value.toJSON()
      };
    }
  };
}

function isRecord(value: unknown): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
