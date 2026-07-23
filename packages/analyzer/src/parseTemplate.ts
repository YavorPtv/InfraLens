import type { CfnResource, CfnTemplate, CfnValue, ResourceNode } from "@infralens/shared";
import { parseDocument, type CollectionTag, type ScalarTag } from "yaml";

export function parseTemplateInput(rawTemplate: string): CfnTemplate {
  const template = parseCloudFormationInput(rawTemplate);

  if (!isRecord(template)) {
    throw new Error("Invalid CloudFormation template: expected a template object.");
  }

  if (!isRecord(template.Resources)) {
    throw new Error("Invalid CloudFormation template: missing Resources object.");
  }

  validateResources(template.Resources);

  return template as unknown as CfnTemplate;
}

export function parseTemplate(rawTemplate: string): ResourceNode[] {
  const cfnTemplate = parseTemplateInput(rawTemplate);

  return templateToResourceNodes(cfnTemplate);
}

export function templateToResourceNodes(cfnTemplate: CfnTemplate): ResourceNode[] {
  validateResources(cfnTemplate.Resources);

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
  const document = parseDocument(rawTemplate, {
    customTags: createCloudFormationYamlTags()
  });

  if (document.errors.length > 0) {
    throw new Error(
      `Invalid CloudFormation template input: ${document.errors
        .map((error) => error.message)
        .join("; ")}`
    );
  }

  return document.toJS({
    maxAliasCount: 100
  }) as unknown;
}

function validateResources(resources: Record<string, unknown>): void {
  for (const [logicalId, resource] of Object.entries(resources)) {
    validateResource(logicalId, resource);
  }
}

function validateResource(logicalId: string, resource: unknown): asserts resource is CfnResource {
  if (!isRecord(resource)) {
    throw new Error(`Invalid CloudFormation resource "${logicalId}": expected an object.`);
  }

  if (typeof resource.Type !== "string" || resource.Type.length === 0) {
    throw new Error(`Invalid CloudFormation resource "${logicalId}": missing Type string.`);
  }

  if (resource.Properties !== undefined && !isRecord(resource.Properties)) {
    throw new Error(`Invalid CloudFormation resource "${logicalId}": Properties must be an object.`);
  }
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
