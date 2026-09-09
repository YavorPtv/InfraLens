import { normalizeSourceFilePath, type SourceFile } from "@infralens/shared";

export const autoDetectMappingValue = "__auto_detect__";
export const sharedSourceMappingValue = "__shared_source__";
export const manualMappingValue = "__manual_lambda_id__";

export interface SourceFileInput extends SourceFile {
  mappingSelection: string;
  manualLambdaFunctionId?: string;
  uploadStatus: "added" | "replaced";
}

export interface BrowserSourceFile {
  name: string;
  webkitRelativePath?: string;
  text(): Promise<string>;
}

export const acceptedSourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export async function readSourceUploads(
  files: BrowserSourceFile[],
  folderUpload = false
): Promise<{ files: SourceFile[]; ignoredCount: number }> {
  const accepted: Array<{ file: BrowserSourceFile; path: string }> = [];
  let ignoredCount = 0;
  for (const file of files) {
    const path = normalizeSourceFilePath(file.webkitRelativePath || file.name);
    const supported = acceptedSourceExtensions.some((extension) => path.toLowerCase().endsWith(extension));
    const ignoredDirectory = path.split("/").some((segment) => segment === "node_modules" || segment === ".git");
    if (!supported || ignoredDirectory) {
      if (!folderUpload) {
        throw new Error("Choose .ts, .tsx, .js, .jsx, .mjs, or .cjs source files outside node_modules and .git.");
      }
      ignoredCount += 1;
      continue;
    }
    accepted.push({ file, path });
  }
  return {
    files: await Promise.all(accepted.map(async ({ file, path }) => ({ path, content: await file.text() }))),
    ignoredCount
  };
}

/** Last upload wins at the exact normalized path; mapping belongs to that path. */
export function mergeSourceFiles(currentFiles: SourceFileInput[], uploadedFiles: SourceFile[]): SourceFileInput[] {
  const filesByPath = new Map(currentFiles.map((file) => [file.path, file]));
  for (const file of uploadedFiles) {
    const path = normalizeSourceFilePath(file.path);
    const current = filesByPath.get(path);
    filesByPath.set(path, {
      path, content: file.content,
      mappingSelection: current?.mappingSelection ?? autoDetectMappingValue,
      manualLambdaFunctionId: current?.manualLambdaFunctionId,
      uploadStatus: current === undefined ? "added" : "replaced"
    });
  }
  return [...filesByPath.values()];
}

export function removeSourceFile(files: SourceFileInput[], path: string): SourceFileInput[] {
  const normalized = normalizeSourceFilePath(path);
  return files.filter((file) => file.path !== normalized);
}

export function toSourceFileMap(sourceFiles: SourceFileInput[]): Record<string, string> | undefined {
  if (sourceFiles.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sourceFiles.map((file) => [file.path, file.content]));
}

export function toSourceFileMappings(
  sourceFiles: SourceFileInput[],
  lambdaLogicalIds: string[]
): Record<string, string> | undefined {
  const mappings = sourceFiles.flatMap((file) => {
    const mappingSelection = getMappingSelection(file, lambdaLogicalIds);
    const lambdaFunctionId =
      mappingSelection === manualMappingValue
        ? file.manualLambdaFunctionId?.trim()
        : mappingSelection;

    return lambdaFunctionId === autoDetectMappingValue ||
      lambdaFunctionId === sharedSourceMappingValue ||
      lambdaFunctionId === undefined ||
      lambdaFunctionId.length === 0
      ? []
      : [[file.path, lambdaFunctionId] as const];
  });

  return mappings.length === 0 ? undefined : Object.fromEntries(mappings);
}

export function toSourceFileExclusions(
  sourceFiles: SourceFileInput[],
  lambdaLogicalIds: string[]
): string[] | undefined {
  const exclusions = sourceFiles
    .filter((file) => getMappingSelection(file, lambdaLogicalIds) === sharedSourceMappingValue)
    .map((file) => file.path);

  return exclusions.length === 0 ? undefined : exclusions;
}

export function getMappingSelection(file: SourceFileInput, lambdaLogicalIds: string[]): string {
  if (
    file.mappingSelection === autoDetectMappingValue ||
    file.mappingSelection === sharedSourceMappingValue ||
    file.mappingSelection === manualMappingValue ||
    lambdaLogicalIds.includes(file.mappingSelection)
  ) {
    return file.mappingSelection;
  }

  return autoDetectMappingValue;
}
