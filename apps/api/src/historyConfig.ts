import type { AnalyzeApiRequest } from "@infralens/shared";
import { AwsHistoryStore, S3ArtifactStore } from "./historyAws";
import { HistoryService, defaultHistoryQuotas, type HistoryQuotas } from "./historyService";
import { MemoryHistoryStore, MemoryArtifactStore } from "./historyStore";
import { analyzeValidatedBody } from "./analyzeRequest";
import { createCloudFormationValidator } from "./cloudFormationValidation";
import { getApiRequestLimits } from "./requestLimits";

export function configuredHistory(
  hosted: boolean,
  environment = process.env
): HistoryService | undefined {
  const adapterMode = environment.INFRALENS_HISTORY_ADAPTER;
  if (!adapterMode) {
    return undefined;
  }
  const quotas: HistoryQuotas = { ...defaultHistoryQuotas };
  for (const quotaName of Object.keys(quotas) as (keyof HistoryQuotas)[]) {
    const uppercaseName = quotaName.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
    const environmentKey = `INFRALENS_QUOTA_${uppercaseName}`;
    const configuredValue = environment[environmentKey];
    if (configuredValue !== undefined) {
      quotas[quotaName] = Number(configuredValue);
    }
  }
  const limits = getApiRequestLimits(environment);
  const validator =
    environment.INFRALENS_CLOUDFORMATION_VALIDATION === "true"
      ? createCloudFormationValidator()
      : undefined;
  const options = {
    quotas,
    limits,
    analyze: (input: AnalyzeApiRequest) =>
      analyzeValidatedBody(JSON.stringify(input), undefined, limits, validator)
  };
  if (
    adapterMode === "memory" &&
    !hosted &&
    environment.INFRALENS_ENVIRONMENT === "development" &&
    environment.NODE_ENV !== "production" &&
    !environment.AWS_LAMBDA_FUNCTION_NAME
  ) {
    return new HistoryService(new MemoryHistoryStore(), new MemoryArtifactStore(), options);
  }
  if (adapterMode !== "aws") {
    throw new Error("History memory adapter is explicitly local-only.");
  }
  const projectsTable = environment.INFRALENS_PROJECTS_TABLE;
  const runsTable = environment.INFRALENS_RUNS_TABLE;
  const artifactBucket = environment.INFRALENS_ARTIFACT_BUCKET;
  if (!projectsTable || !runsTable || !artifactBucket) {
    throw new Error("AWS history tables and artifact bucket are required.");
  }
  return new HistoryService(
    new AwsHistoryStore({
      projects: projectsTable,
      runs: runsTable
    }),
    new S3ArtifactStore(artifactBucket),
    options
  );
}

export function localHistoryOwner(environment = process.env): string | undefined {
  if (
    environment.INFRALENS_LOCAL_OWNER &&
    (environment.INFRALENS_ENVIRONMENT !== "development" ||
      environment.NODE_ENV === "production" ||
      environment.AWS_LAMBDA_FUNCTION_NAME ||
      environment.INFRALENS_HISTORY_ADAPTER !== "memory")
  ) {
    throw new Error(
      "Local identity is allowed only with explicitly configured development memory storage."
    );
  }
  return environment.INFRALENS_LOCAL_OWNER;
}
