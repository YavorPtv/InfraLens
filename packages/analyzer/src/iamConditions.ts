import type { CfnValue, IamConditionAnalysis } from "@infralens/shared";

// Positive operators on single-valued context keys only. Intrinsics, policy
// variables, IfExists, negation and set operators remain explicitly unknown.
const conditionKeys: Record<string, { operators: string[]; description: string; valid: (value: string) => boolean }> = {
  "aws:sourcearn": { operators: ["ArnEquals", "StringEquals"], description: "request source ARN", valid: isLiteralArn },
  "aws:principalarn": { operators: ["ArnEquals", "StringEquals"], description: "request principal ARN", valid: isLiteralArn },
  "aws:sourceaccount": { operators: ["StringEquals"], description: "source account", valid: value => /^\d{12}$/.test(value) },
  "aws:requestedregion": { operators: ["StringEquals"], description: "requested endpoint region (not every affected resource's location)", valid: value => /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(value) },
  "aws:securetransport": { operators: ["Bool"], description: "transport security (does not scope actions or resources)", valid: value => value === "true" || value === "false" }
};

export function analyzeIamCondition(condition: CfnValue | undefined): IamConditionAnalysis {
  if (condition === undefined) return { status: "none", restrictions: [], unknown: [] };
  const restrictions: string[] = [];
  const unknown: string[] = [];
  if (!isRecord(condition) || Object.keys(condition).length === 0) {
    return { status: "unknown", restrictions, unknown: ["Empty or unresolved Condition"], value: condition };
  }
  for (const [operator, operands] of Object.entries(condition)) {
    if (!isRecord(operands) || Object.keys(operands).length === 0) { unknown.push(operator); continue; }
    for (const [key, operand] of Object.entries(operands)) {
      const metadata = Object.hasOwn(conditionKeys, key.toLowerCase()) ? conditionKeys[key.toLowerCase()] : undefined;
      const values = Array.isArray(operand) ? operand : [operand];
      const literals = values.map(value => typeof value === "boolean" ? String(value) : value);
      if (metadata?.operators.includes(operator) && literals.length > 0 &&
          literals.every(value => typeof value === "string" && metadata.valid(value))) {
        restrictions.push(`${operator} ${key} restricts ${metadata.description}; alternatives within a key are OR, separate keys/operators are AND.`);
      } else { unknown.push(`${operator} ${key}`); }
    }
  }
  return { status: unknown.length > 0 ? "unknown" : "understood", restrictions, unknown, value: condition };
}

export function describeIamCondition(condition: IamConditionAnalysis): string {
  if (condition.status === "none") return "";
  return [...condition.restrictions,
    ...(condition.unknown.length ? [`The statement contains conditions InfraLens did not fully evaluate: ${condition.unknown.join(", ")}.`] : []),
    "Conditions limit when this statement applies; they do not establish that wildcard permissions are safe."
  ].join(" ");
}

function isLiteralArn(value: string): boolean {
  return /^arn:[^:]+:[^:]+:[^:]*:[^:]*:.+$/.test(value) && !/[*?$\{]/.test(value);
}

export function isRecord(value: CfnValue | undefined): value is Record<string, CfnValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
