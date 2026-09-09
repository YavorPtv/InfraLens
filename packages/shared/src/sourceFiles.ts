/** A source file's identity is its case-sensitive, project-relative path. */
export interface SourceFile {
  path: string;
  content: string;
}

/** Existing wire format: normalized source paths are keys, never basenames derived from them. */
export interface SourceAnalysisInput {
  sourceFiles?: Record<string, string>;
  sourceFileMappings?: Record<string, string>;
  sourceFileExclusions?: string[];
}

export interface AnalyzeApiRequest extends SourceAnalysisInput {
  template: string;
}

export class SourcePathError extends Error {}

export function normalizeSourceFilePath(path: string): string {
  const relativePath = path.replace(/\\/g, "/");
  // Do not echo invalid paths: they may contain private machine prefixes.
  if (relativePath.startsWith("/") || /[:\x00-\x1f\x7f]/.test(relativePath)) {
    throw new SourcePathError("Source paths must be relative project paths without drive names or control characters.");
  }
  const segments: string[] = [];
  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new SourcePathError("Source paths must not traverse outside the uploaded project.");
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const normalized = segments.join("/");
  if (normalized.trim() === "" || relativePath.endsWith("/")) {
    throw new SourcePathError("Source paths must identify a file.");
  }
  return normalized;
}

function normalizePathMap(values: Record<string, string>): Record<string, string> {
  const entries = new Map<string, string>();
  for (const [path, value] of Object.entries(values)) {
    const normalized = normalizeSourceFilePath(path);
    if (entries.has(normalized)) {
      throw new SourcePathError("Source input contains duplicate normalized paths.");
    }
    entries.set(normalized, value);
  }
  return Object.fromEntries(entries);
}

/** Shape/size validation belongs to the API; identity normalization is shared by all callers. */
export function normalizeSourceAnalysisInput(input: SourceAnalysisInput): SourceAnalysisInput {
  const sourceFiles = input.sourceFiles === undefined ? undefined : normalizePathMap(input.sourceFiles);
  const sourceFileMappings = input.sourceFileMappings === undefined ? undefined : normalizePathMap(input.sourceFileMappings);
  const sourceFileExclusions = input.sourceFileExclusions?.map(normalizeSourceFilePath);
  if (sourceFileExclusions !== undefined && new Set(sourceFileExclusions).size !== sourceFileExclusions.length) {
    throw new SourcePathError("Source exclusions contain duplicate normalized paths.");
  }
  return {
    ...(sourceFiles === undefined ? {} : { sourceFiles }),
    ...(sourceFileMappings === undefined ? {} : { sourceFileMappings }),
    ...(sourceFileExclusions === undefined ? {} : { sourceFileExclusions })
  };
}
