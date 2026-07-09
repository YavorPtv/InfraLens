import type { CfnResource, CfnTemplate, CfnValue, ResourceNode } from "@infralens/shared";

export function parseTemplate(rawJson: string): ResourceNode[] {
  const template = parseJson(rawJson);

  if (!isRecord(template)) {
    throw new Error("Invalid CloudFormation template: expected a JSON object.");
  }

  if (!isRecord(template.Resources)) {
    throw new Error("Invalid CloudFormation template: missing Resources object.");
  }

  const cfnTemplate = template as unknown as CfnTemplate;

  return Object.entries(cfnTemplate.Resources).map(([logicalId, resource]) =>
    toResourceNode(logicalId, resource)
  );
}

function parseJson(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`Invalid CloudFormation JSON: ${detail}`);
  }
}

function toResourceNode(logicalId: string, resource: CfnResource): ResourceNode {
  if (!isRecord(resource)) {
    throw new Error(`Invalid CloudFormation resource "${logicalId}": expected an object.`);
  }

  if (typeof resource.Type !== "string" || resource.Type.length === 0) {
    throw new Error(`Invalid CloudFormation resource "${logicalId}": missing Type string.`);
  }

  if (resource.Properties !== undefined && !isRecord(resource.Properties)) {
    throw new Error(`Invalid CloudFormation resource "${logicalId}": Properties must be an object.`);
  }

  return {
    id: logicalId,
    type: resource.Type,
    properties: resource.Properties ?? {}
  };
}

function isRecord(value: unknown): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
