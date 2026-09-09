import type { CfnResource, CfnTemplate } from "@infralens/shared";
import { normalizeSourceAnalysisInput, normalizeSourceFilePath } from "@infralens/shared";
import { getAwsSdkCommandMappings } from "./serviceMetadata";

export type SourceCodeActionInferenceConfidence = "low" | "medium" | "high";

export interface SourceCodeActionInference {
  action: string;
  filePath: string;
  lambdaFunctionId?: string;
  rootFilePath?: string;
  importChain?: string[];
  matchedCommand: string;
  confidence: SourceCodeActionInferenceConfidence;
  actionConfidence?: SourceCodeActionInferenceConfidence;
  sdkPackage?: string;
  evidence: string;
}

export interface SourceFileLambdaMapping {
  lambdaFunctionId: string;
  confidence: SourceCodeActionInferenceConfidence;
  evidence: string;
}

export interface InferIamActionsFromSourceCodeOptions {
  template?: CfnTemplate;
  sourceFileMappings?: Record<string, string>;
  sourceFileExclusions?: string[];
}

interface ReachableSourceFile {
  filePath: string;
  importChain: string[];
}

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const awsSdkCommandActionMappings = getAwsSdkCommandMappings();

export function inferIamActionsFromSourceCode(
  files: Record<string, string>,
  options: InferIamActionsFromSourceCodeOptions = {}
): SourceCodeActionInference[] {
  const normalizedInput = normalizeSourceAnalysisInput({
    sourceFiles: files,
    sourceFileMappings: options.sourceFileMappings,
    sourceFileExclusions: options.sourceFileExclusions
  });
  files = normalizedInput.sourceFiles!;
  options = { ...options, ...normalizedInput };
  const sourceFileMappings = mapSourceFilesToLambdaFunctions(files, options);
  const sourceFileExclusions = new Set(options.sourceFileExclusions ?? []);
  const importGraph = buildSourceFileImportGraph(files);
  const reachedSourceFiles = new Set<string>();
  const inferences = new Map<string, SourceCodeActionInference>();

  for (const [rootFilePath, sourceFileMapping] of sourceFileMappings) {
    for (const reachableFile of findReachableSourceFiles(rootFilePath, importGraph)) {
      reachedSourceFiles.add(reachableFile.filePath);

      for (const inference of inferIamActionsFromSourceFile(
        reachableFile.filePath,
        files[reachableFile.filePath],
        sourceFileMapping,
        rootFilePath,
        reachableFile.importChain
      )) {
        addStrongestInference(inferences, inference);
      }
    }
  }

  for (const [filePath, sourceCode] of Object.entries(files)) {
    if (sourceFileExclusions.has(filePath) || reachedSourceFiles.has(filePath)) {
      continue;
    }

    for (const inference of inferIamActionsFromSourceFile(filePath, sourceCode)) {
      addStrongestInference(inferences, inference);
    }
  }

  return [...inferences.values()];
}

function inferIamActionsFromSourceFile(
  filePath: string,
  sourceCode: string,
  sourceFileMapping?: SourceFileLambdaMapping,
  rootFilePath?: string,
  importChain?: string[]
): SourceCodeActionInference[] {
  const isImportedSource = rootFilePath !== undefined && rootFilePath !== filePath;

  return awsSdkCommandActionMappings.flatMap((commandMapping) => {
    if (!containsCommandUsage(sourceCode, commandMapping.commandName)) {
      return [];
    }

    const hasExpectedPackage = containsPackageImport(sourceCode, commandMapping.packageName);
    return [
      {
        action: commandMapping.action,
        filePath,
        ...(sourceFileMapping === undefined
          ? {}
          : { lambdaFunctionId: sourceFileMapping.lambdaFunctionId }),
        ...(isImportedSource ? { rootFilePath, importChain } : {}),
        matchedCommand: commandMapping.commandName,
        confidence: sourceFileMapping?.confidence ?? "low",
        ...(hasExpectedPackage
          ? { actionConfidence: "high" as const, sdkPackage: commandMapping.packageName }
          : {}),
        evidence: sourceFileMapping?.evidence ?? `No Lambda source mapping found for ${filePath}.`
      }
    ];
  });
}

function mapSourceFilesToLambdaFunctions(
  files: Record<string, string>,
  options: InferIamActionsFromSourceCodeOptions
): Map<string, SourceFileLambdaMapping> {
  const mappings = new Map<string, SourceFileLambdaMapping>();
  const lambdaFunctions = getLambdaFunctions(options.template);
  const sourceFileExclusions = new Set(options.sourceFileExclusions ?? []);
  const availableRootFileCount = Object.keys(files).filter(
    (filePath) => !sourceFileExclusions.has(filePath)
  ).length;

  for (const filePath of Object.keys(files)) {
    if (sourceFileExclusions.has(filePath)) {
      continue;
    }

    const explicitMapping = getExplicitMapping(filePath, options.sourceFileMappings, lambdaFunctions);
    if (explicitMapping !== undefined) {
      mappings.set(filePath, explicitMapping);
      continue;
    }

    const automaticMapping = getAutomaticMapping(
      filePath,
      lambdaFunctions,
      availableRootFileCount === 1,
      Object.keys(files).filter((path) => !sourceFileExclusions.has(path))
    );
    if (automaticMapping !== undefined) {
      mappings.set(filePath, automaticMapping);
    }
  }

  return mappings;
}

function getLambdaFunctions(
  template: CfnTemplate | undefined
): Array<{ resourceId: string; resource: CfnResource }> {
  if (template === undefined) {
    return [];
  }

  return Object.entries(template.Resources).flatMap(([resourceId, resource]) =>
    resource.Type === "AWS::Lambda::Function" ? [{ resourceId, resource }] : []
  );
}

function getExplicitMapping(
  filePath: string,
  sourceFileMappings: Record<string, string> | undefined,
  lambdaFunctions: Array<{ resourceId: string; resource: CfnResource }>
): SourceFileLambdaMapping | undefined {
  const lambdaFunctionId = sourceFileMappings?.[filePath];

  if (
    lambdaFunctionId === undefined ||
    !lambdaFunctions.some((lambdaFunction) => lambdaFunction.resourceId === lambdaFunctionId)
  ) {
    return undefined;
  }

  return {
    lambdaFunctionId,
    confidence: "high",
    evidence: `sourceFileMappings.${filePath}`
  };
}

function getAutomaticMapping(
  filePath: string,
  lambdaFunctions: Array<{ resourceId: string; resource: CfnResource }>,
  allowSingleLambdaFallback: boolean,
  sourcePaths: string[]
): SourceFileLambdaMapping | undefined {
  const candidates = lambdaFunctions.flatMap((lambdaFunction) =>
    getMappingCandidatesForLambda(filePath, lambdaFunction.resourceId, lambdaFunction.resource, sourcePaths)
  );

  if (candidates.length === 0 && lambdaFunctions.length === 1 && allowSingleLambdaFallback) {
    return {
      lambdaFunctionId: lambdaFunctions[0].resourceId,
      confidence: "low",
      evidence: "single Lambda function in template"
    };
  }

  const highestScore = Math.max(...candidates.map((candidate) => getConfidenceScore(candidate.confidence)), -1);
  const strongestCandidates = candidates.filter(
    (candidate) => getConfidenceScore(candidate.confidence) === highestScore
  );
  const strongestLambdaFunctionIds = new Set(
    strongestCandidates.map((candidate) => candidate.lambdaFunctionId)
  );

  return strongestLambdaFunctionIds.size === 1 ? strongestCandidates[0] : undefined;
}

function getMappingCandidatesForLambda(
  filePath: string,
  lambdaFunctionId: string,
  resource: CfnResource,
  sourcePaths: string[]
): SourceFileLambdaMapping[] {
  return [
    ...getMetadataMappingCandidates(filePath, lambdaFunctionId, resource, sourcePaths),
    ...getHandlerMappingCandidates(filePath, lambdaFunctionId, resource, sourcePaths),
    ...getCodeMappingCandidates(filePath, lambdaFunctionId, resource, sourcePaths),
    ...getFileNameMappingCandidates(filePath, lambdaFunctionId, resource, sourcePaths)
  ];
}

function getMetadataMappingCandidates(
  filePath: string,
  lambdaFunctionId: string,
  resource: CfnResource,
  sourcePaths: string[]
): SourceFileLambdaMapping[] {
  const candidates = getMetadataSourceFiles(resource.Metadata);

  return candidates
    .filter((candidate) => sourcePathMatches(filePath, candidate.filePath, sourcePaths, false))
    .map((candidate) => ({
      lambdaFunctionId,
      confidence: "high",
      evidence: `Resources.${lambdaFunctionId}.Metadata.${candidate.evidenceKey}`
    }));
}

function getMetadataSourceFiles(
  metadata: Record<string, unknown> | undefined
): Array<{ filePath: string; evidenceKey: string }> {
  if (metadata === undefined) {
    return [];
  }

  const directKeys = ["sourceFile", "SourceFile", "InfraLensSourceFile"];
  const directValues = directKeys.flatMap((key) =>
    typeof metadata[key] === "string" ? [{ filePath: metadata[key], evidenceKey: key }] : []
  );
  const nestedInfraLens = isRecord(metadata.InfraLens) ? metadata.InfraLens : undefined;
  const nestedSourceFile =
    typeof nestedInfraLens?.SourceFile === "string"
      ? [{ filePath: nestedInfraLens.SourceFile, evidenceKey: "InfraLens.SourceFile" }]
      : [];
  const nestedSourceFiles = Array.isArray(nestedInfraLens?.SourceFiles)
    ? nestedInfraLens.SourceFiles.flatMap((value, index) =>
        typeof value === "string"
          ? [{ filePath: value, evidenceKey: `InfraLens.SourceFiles[${index}]` }]
          : []
      )
    : [];

  return [...directValues, ...nestedSourceFile, ...nestedSourceFiles];
}

function getHandlerMappingCandidates(
  filePath: string,
  lambdaFunctionId: string,
  resource: CfnResource,
  sourcePaths: string[]
): SourceFileLambdaMapping[] {
  const handler = resource.Properties?.Handler;

  if (typeof handler !== "string") {
    return [];
  }

  const handlerModule = getHandlerModuleName(handler);
  if (!sourcePathMatches(filePath, handlerModule, sourcePaths)) {
    return [];
  }

  return [
    {
      lambdaFunctionId,
      confidence: "medium",
      evidence: `Resources.${lambdaFunctionId}.Properties.Handler`
    }
  ];
}

function getCodeMappingCandidates(
  filePath: string,
  lambdaFunctionId: string,
  resource: CfnResource,
  sourcePaths: string[]
): SourceFileLambdaMapping[] {
  const code = resource.Properties?.Code;
  if (!isRecord(code)) {
    return [];
  }

  const codePaths = ["S3Key", "File", "Path"].flatMap((key) =>
    typeof code[key] === "string" ? [{ filePath: code[key], evidenceKey: key }] : []
  );

  return codePaths
    .filter((candidate) => sourcePathMatches(filePath, candidate.filePath, sourcePaths))
    .map((candidate) => ({
      lambdaFunctionId,
      confidence: "low",
      evidence: `Resources.${lambdaFunctionId}.Properties.Code.${candidate.evidenceKey}`
    }));
}

function getFileNameMappingCandidates(
  filePath: string,
  lambdaFunctionId: string,
  resource: CfnResource,
  sourcePaths: string[]
): SourceFileLambdaMapping[] {
  const fileStem = normalizeIdentifier(getFileStem(filePath));
  if (sourcePaths.filter((path) => normalizeIdentifier(getFileStem(path)) === fileStem).length !== 1) {
    return [];
  }
  const logicalIdAliases = getLambdaNameAliases(lambdaFunctionId);
  const functionName = resource.Properties?.FunctionName;
  const functionNameAliases =
    typeof functionName === "string" ? getLambdaNameAliases(functionName) : [];

  if (![...logicalIdAliases, ...functionNameAliases].includes(fileStem)) {
    return [];
  }

  return [
    {
      lambdaFunctionId,
      confidence: "low",
      evidence: `source file name matched Lambda ${lambdaFunctionId}`
    }
  ];
}

function getHandlerModuleName(handler: string): string {
  const lastDotIndex = handler.lastIndexOf(".");

  return lastDotIndex === -1 ? handler : handler.slice(0, lastDotIndex);
}

function sourcePathMatches(
  filePath: string,
  candidatePath: string,
  sourcePaths: string[],
  allowBasenameFallback = true
): boolean {
  let candidate: string;
  try {
    candidate = stripSourceExtension(normalizeSourceFilePath(candidatePath));
  } catch {
    return false;
  }
  const exact = sourcePaths.filter((path) => stripSourceExtension(path) === candidate);
  // Folder selection includes the selected directory name. Accept a unique path suffix.
  const matches = exact.length > 0 ? exact : sourcePaths.filter((path) =>
    stripSourceExtension(path).endsWith(`/${candidate}`)
  );
  if (matches.length > 0) return matches.length === 1 && matches[0] === filePath;
  // Basename-only uploads can still match a template handler, but never guess between directories.
  if (!allowBasenameFallback || (filePath.includes("/") && candidate.includes("/"))) return false;
  const basenameMatches = sourcePaths.filter((path) =>
    normalizeIdentifier(getFileStem(path)) === normalizeIdentifier(getFileStem(candidate))
  );
  return basenameMatches.length === 1 && basenameMatches[0] === filePath;
}

function getLambdaNameAliases(name: string): string[] {
  const normalizedName = normalizeIdentifier(name);
  const suffixes = ["function", "lambda", "handler"];
  const aliases = new Set([normalizedName]);

  for (const suffix of suffixes) {
    if (normalizedName.endsWith(suffix)) {
      aliases.add(normalizedName.slice(0, -suffix.length));
    }
  }

  return [...aliases].filter((alias) => alias.length > 0);
}

function getFileStem(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);

  return stripSourceExtension(fileName);
}

function stripSourceExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, "");
}

function buildSourceFileImportGraph(files: Record<string, string>): Map<string, string[]> {
  const filePathsByNormalizedPath = new Map<string, string[]>();

  for (const filePath of Object.keys(files)) {
    const normalizedPath = normalizeSourceFilePath(filePath);
    const matchingPaths = filePathsByNormalizedPath.get(normalizedPath) ?? [];
    matchingPaths.push(filePath);
    filePathsByNormalizedPath.set(normalizedPath, matchingPaths);
  }

  return new Map(
    Object.entries(files).map(([filePath, sourceCode]) => {
      const imports = new Set<string>();

      for (const importSpecifier of extractLocalImportSpecifiers(sourceCode)) {
        const resolvedFilePath = resolveLocalImport(
          filePath,
          importSpecifier,
          filePathsByNormalizedPath
        );

        if (resolvedFilePath !== undefined) {
          imports.add(resolvedFilePath);
        }
      }

      return [filePath, [...imports]];
    })
  );
}

function extractLocalImportSpecifiers(sourceCode: string): string[] {
  const importSpecifiers = new Set<string>();
  const esModuleImportPattern =
    /\bimport\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;
  const commonJsRequirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const pattern of [esModuleImportPattern, commonJsRequirePattern]) {
    for (const match of sourceCode.matchAll(pattern)) {
      const importSpecifier = match[1];
      if (isRelativeImport(importSpecifier)) {
        importSpecifiers.add(importSpecifier);
      }
    }
  }

  return [...importSpecifiers];
}

function resolveLocalImport(
  importingFilePath: string,
  importSpecifier: string,
  filePathsByNormalizedPath: Map<string, string[]>
): string | undefined {
  const importingDirectory = getSourceDirectory(importingFilePath);
  let importPath: string;
  try {
    // Import specifiers may name directories; uploaded source identities must name files.
    const relativeImport = importSpecifier.replace(/\/+$/, "");
    importPath = normalizeSourceFilePath(
      importingDirectory === "" ? relativeImport : `${importingDirectory}/${relativeImport}`
    );
  } catch {
    return undefined;
  }
  const candidatePaths = hasSourceExtension(importPath)
    ? [importPath]
    : [
        ...sourceExtensions.map((extension) => `${importPath}${extension}`),
        ...sourceExtensions.map((extension) => `${importPath}/index${extension}`)
      ];
  const matchingPaths = candidatePaths.flatMap(
    (candidatePath) => filePathsByNormalizedPath.get(candidatePath) ?? []
  );

  return matchingPaths.length === 1 ? matchingPaths[0] : undefined;
}

function findReachableSourceFiles(
  rootFilePath: string,
  importGraph: Map<string, string[]>
): ReachableSourceFile[] {
  const reachableFiles: ReachableSourceFile[] = [];
  const visited = new Set<string>();
  const queue: ReachableSourceFile[] = [
    {
      filePath: rootFilePath,
      importChain: [rootFilePath]
    }
  ];

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const currentFile = queue[queueIndex];
    if (visited.has(currentFile.filePath)) {
      continue;
    }

    visited.add(currentFile.filePath);
    reachableFiles.push(currentFile);

    for (const importedFilePath of importGraph.get(currentFile.filePath) ?? []) {
      if (!visited.has(importedFilePath)) {
        queue.push({
          filePath: importedFilePath,
          importChain: [...currentFile.importChain, importedFilePath]
        });
      }
    }
  }

  return reachableFiles;
}

function addStrongestInference(
  inferences: Map<string, SourceCodeActionInference>,
  candidate: SourceCodeActionInference
): void {
  const inferenceKey = `${candidate.lambdaFunctionId ?? ""}\u0000${candidate.filePath}\u0000${candidate.action}`;
  const existing = inferences.get(inferenceKey);

  if (existing === undefined || isStrongerInference(candidate, existing)) {
    inferences.set(inferenceKey, candidate);
  }
}

function isStrongerInference(
  candidate: SourceCodeActionInference,
  existing: SourceCodeActionInference
): boolean {
  const candidateConfidence = getConfidenceScore(candidate.confidence);
  const existingConfidence = getConfidenceScore(existing.confidence);

  if (candidateConfidence !== existingConfidence) {
    return candidateConfidence > existingConfidence;
  }

  return (candidate.importChain?.length ?? 1) < (existing.importChain?.length ?? 1);
}

function isRelativeImport(importSpecifier: string): boolean {
  return importSpecifier.startsWith("./") || importSpecifier.startsWith("../");
}

function hasSourceExtension(filePath: string): boolean {
  return sourceExtensions.some((extension) => filePath.toLowerCase().endsWith(extension));
}

function getSourceDirectory(filePath: string): string {
  const normalizedPath = normalizeSourceFilePath(filePath);
  const lastSlashIndex = normalizedPath.lastIndexOf("/");

  return lastSlashIndex === -1 ? "" : normalizedPath.slice(0, lastSlashIndex);
}

function normalizeIdentifier(value: string): string {
  return stripSourceExtension(value)
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getConfidenceScore(confidence: SourceCodeActionInferenceConfidence): number {
  return {
    low: 1,
    medium: 2,
    high: 3
  }[confidence];
}

function containsCommandUsage(sourceCode: string, commandName: string): boolean {
  return new RegExp(`\\bnew\\s+${escapeRegExp(commandName)}\\s*\\(`).test(sourceCode);
}

function containsPackageImport(sourceCode: string, packageName: string): boolean {
  const packagePattern = escapeRegExp(packageName);
  return new RegExp(
    `(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*)["']${packagePattern}["']`
  ).test(sourceCode);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
