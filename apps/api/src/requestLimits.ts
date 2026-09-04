export interface ApiRequestLimits {
  maxRequestBytes: number;
  maxTemplateBytes: number;
  maxSourceFiles: number;
  maxSourceFileBytes: number;
  maxCombinedSourceBytes: number;
  maxSourceMappings: number;
  maxSourceExclusions: number;
  maxDiffTemplateBytes: number;
  maxFixes: number;
}

export const defaultApiRequestLimits: ApiRequestLimits = {
  maxRequestBytes: 4 * 1024 * 1024,
  maxTemplateBytes: 1024 * 1024,
  maxSourceFiles: 100,
  maxSourceFileBytes: 256 * 1024,
  maxCombinedSourceBytes: 2 * 1024 * 1024,
  maxSourceMappings: 100,
  maxSourceExclusions: 100,
  maxDiffTemplateBytes: 2 * 1024 * 1024,
  maxFixes: 200
};

const environmentKeys: Record<keyof ApiRequestLimits, string> = {
  maxRequestBytes: "INFRALENS_MAX_REQUEST_BYTES",
  maxTemplateBytes: "INFRALENS_MAX_TEMPLATE_BYTES",
  maxSourceFiles: "INFRALENS_MAX_SOURCE_FILES",
  maxSourceFileBytes: "INFRALENS_MAX_SOURCE_FILE_BYTES",
  maxCombinedSourceBytes: "INFRALENS_MAX_COMBINED_SOURCE_BYTES",
  maxSourceMappings: "INFRALENS_MAX_SOURCE_MAPPINGS",
  maxSourceExclusions: "INFRALENS_MAX_SOURCE_EXCLUSIONS",
  maxDiffTemplateBytes: "INFRALENS_MAX_DIFF_TEMPLATE_BYTES",
  maxFixes: "INFRALENS_MAX_FIXES"
};

export function getApiRequestLimits(
  environment: NodeJS.ProcessEnv = process.env
): ApiRequestLimits {
  return Object.fromEntries(
    Object.entries(environmentKeys).map(([key, environmentKey]) => {
      const limitKey = key as keyof ApiRequestLimits;
      return [limitKey, readPositiveInteger(environment[environmentKey], defaultApiRequestLimits[limitKey])];
    })
  ) as unknown as ApiRequestLimits;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
