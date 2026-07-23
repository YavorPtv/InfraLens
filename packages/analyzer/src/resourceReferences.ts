export interface ResourceReference {
  resourceId: string;
  evidencePath: string;
}

const supportedIntrinsicKeys = new Set([
  "Ref",
  "Fn::GetAtt",
  "Fn::Sub",
  "Fn::Join",
  "Fn::If",
  "Fn::ImportValue"
]);

export function extractResourceReferences(value: unknown, path: string): ResourceReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => extractResourceReferences(item, `${path}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const references = extractIntrinsicReferences(value, path);
  const childReferences = Object.entries(value).flatMap(([key, childValue]) =>
    supportedIntrinsicKeys.has(key)
      ? []
      : extractResourceReferences(childValue, appendPath(path, key))
  );

  return [...references, ...childReferences];
}

function extractIntrinsicReferences(
  value: Record<string, unknown>,
  path: string
): ResourceReference[] {
  const references: ResourceReference[] = [];

  if (typeof value.Ref === "string") {
    references.push({
      resourceId: value.Ref,
      evidencePath: `${path}.Ref`
    });
  }

  const getAtt = value["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
    references.push({
      resourceId: getAtt[0],
      evidencePath: `${path}.Fn::GetAtt[0]`
    });
  }

  if (typeof getAtt === "string") {
    references.push({
      resourceId: getAtt.split(".")[0],
      evidencePath: `${path}.Fn::GetAtt`
    });
  }

  references.push(...extractFnSubReferences(value["Fn::Sub"], `${path}.Fn::Sub`));
  references.push(...extractFnJoinReferences(value["Fn::Join"], `${path}.Fn::Join`));
  references.push(...extractFnIfReferences(value["Fn::If"], `${path}.Fn::If`));
  references.push(
    ...extractFnImportValueReferences(value["Fn::ImportValue"], `${path}.Fn::ImportValue`)
  );

  return references;
}

function extractFnSubReferences(value: unknown, path: string): ResourceReference[] {
  if (typeof value === "string") {
    return extractFnSubStringReferences(value, path);
  }

  if (Array.isArray(value)) {
    const [templateString, variables] = value;
    const variableNames = isRecord(variables) ? Object.keys(variables) : [];

    return [
      ...(typeof templateString === "string"
        ? extractFnSubStringReferences(templateString, `${path}[0]`).filter(
            (reference) => !variableNames.includes(reference.resourceId)
          )
        : []),
      ...extractResourceReferences(variables, `${path}[1]`)
    ];
  }

  return [];
}

function extractFnJoinReferences(value: unknown, path: string): ResourceReference[] {
  if (!Array.isArray(value)) {
    return extractResourceReferences(value, path);
  }

  const [, values] = value;

  return extractResourceReferences(values, `${path}[1]`);
}

function extractFnIfReferences(value: unknown, path: string): ResourceReference[] {
  if (!Array.isArray(value)) {
    return extractResourceReferences(value, path);
  }

  const [, valueIfTrue, valueIfFalse] = value;

  return [
    ...extractResourceReferences(valueIfTrue, `${path}[1]`),
    ...extractResourceReferences(valueIfFalse, `${path}[2]`)
  ];
}

function extractFnImportValueReferences(value: unknown, path: string): ResourceReference[] {
  if (typeof value === "string") {
    return [];
  }

  return extractResourceReferences(value, path);
}

function extractFnSubStringReferences(value: string, path: string): ResourceReference[] {
  return Array.from(value.matchAll(/\$\{([^!][^}]+)\}/g))
    .map((match) => match[1].split(".")[0])
    .map((resourceId) => ({
      resourceId,
      evidencePath: path
    }));
}

function appendPath(path: string, key: string): string {
  return `${path}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
