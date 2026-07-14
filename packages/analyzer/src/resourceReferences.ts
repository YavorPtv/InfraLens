export interface ResourceReference {
  resourceId: string;
  evidencePath: string;
}

export function extractResourceReferences(value: unknown, path: string): ResourceReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => extractResourceReferences(item, `${path}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const references = extractIntrinsicReferences(value, path);
  const childReferences = Object.entries(value).flatMap(([key, childValue]) =>
    extractResourceReferences(childValue, appendPath(path, key))
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

function extractFnSubStringReferences(value: string, path: string): ResourceReference[] {
  return Array.from(value.matchAll(/\$\{([^!][^}]+)\}/g))
    .map((match) => match[1].split(".")[0])
    .filter((resourceId) => !resourceId.includes("::"))
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
