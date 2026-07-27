import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { analyzeTemplate } from "../api/analyzeTemplate";
import { useAnalysisReport } from "../reportState";

const acceptedTemplateExtensions = [".json", ".yaml", ".yml"];
const acceptedSourceExtensions = [".ts", ".js", ".mjs", ".cjs"];
const autoDetectMappingValue = "__auto_detect__";
const sharedSourceMappingValue = "__shared_source__";
const manualMappingValue = "__manual_lambda_id__";

interface SourceFileInput {
  path: string;
  content: string;
  mappingSelection: string;
  manualLambdaFunctionId?: string;
}

interface UploadedSourceFileInput {
  path: string;
  content: string;
}

export function AnalyzePage() {
  const [templateInput, setTemplateInput] = useState("");
  const [sourceFiles, setSourceFiles] = useState<SourceFileInput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const { setReport } = useAnalysisReport();
  const lambdaLogicalIds = useMemo(
    () => extractLambdaLogicalIds(templateInput),
    [templateInput]
  );

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];

    if (file === undefined) {
      return;
    }

    if (!isAcceptedTemplateFile(file.name)) {
      setError("Choose a .json, .yaml, or .yml CloudFormation template file.");
      event.target.value = "";
      return;
    }

    setTemplateInput(await file.text());
    setError(null);
  }

  async function handleSourceFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []);

    if (files.length === 0) {
      return;
    }

    const invalidFile = files.find((file) => !isAcceptedSourceFile(file.name));
    if (invalidFile !== undefined) {
      setError("Choose only .ts, .js, .mjs, or .cjs Lambda source files.");
      event.target.value = "";
      return;
    }

    const uploadedFiles = await Promise.all(
      files.map(async (file) => ({
        path: file.name,
        content: await file.text()
      }))
    );

    setSourceFiles((currentFiles) => mergeSourceFiles(currentFiles, uploadedFiles));
    setError(null);
    event.target.value = "";
  }

  async function handleAnalyze(): Promise<void> {
    if (templateInput.trim().length === 0) {
      setError("Paste a CloudFormation template or upload a template file first.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const report = await analyzeTemplate({
        templateInput,
        sourceFiles: toSourceFileMap(sourceFiles),
        sourceFileMappings: toSourceFileMappings(sourceFiles, lambdaLogicalIds),
        sourceFileExclusions: toSourceFileExclusions(sourceFiles, lambdaLogicalIds)
      });
      setReport(report);
      navigate("/report");
    } catch (analysisError) {
      setReport(null);
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Template analysis failed. Check the template and try again."
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <section className="page-section analyze-layout">
      <div className="input-toolbar">
        <div>
          <label className="input-label" htmlFor="template-input">
            CloudFormation Template
          </label>
          <p className="muted-note">Paste a JSON or YAML template, or upload a local file.</p>
        </div>
        <div className="file-upload">
          <input
            accept=".json,.yaml,.yml,application/json,application/x-yaml,application/yaml,text/yaml"
            className="file-input"
            id="template-file"
            onChange={(event) => {
              void handleFileChange(event);
            }}
            ref={fileInputRef}
            type="file"
          />
          <button
            className="secondary-button"
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            Upload JSON
          </button>
        </div>
      </div>

      <textarea
        className="template-input"
        id="template-input"
        onChange={(event) => {
          setTemplateInput(event.target.value);
          setError(null);
        }}
        placeholder='Paste a template here, for example { "Resources": {} }'
        value={templateInput}
      />

      <section className="source-upload-panel" aria-labelledby="source-upload-heading">
        <div>
          <h2 id="source-upload-heading">Lambda Source Files</h2>
          <p className="muted-note">
            Optional. Source-code analysis is used only for IAM action inference.
          </p>
        </div>

        <div className="source-upload-actions">
          <input
            accept=".ts,.js,.mjs,.cjs,text/javascript,application/javascript"
            className="file-input"
            id="source-files"
            multiple
            onChange={(event) => {
              void handleSourceFileChange(event);
            }}
            ref={sourceFileInputRef}
            type="file"
          />
          <button
            className="secondary-button"
            onClick={() => sourceFileInputRef.current?.click()}
            type="button"
          >
            Upload Source Files
          </button>
          {sourceFiles.length > 0 ? (
            <button
              className="secondary-button"
              onClick={() => setSourceFiles([])}
              type="button"
            >
              Clear Files
            </button>
          ) : null}
        </div>

        {sourceFiles.length > 0 && lambdaLogicalIds.length === 0 ? (
          <p className="lambda-empty-state">
            {templateInput.trim().length === 0
              ? "Paste or upload a template to list available Lambda functions."
              : "No AWS::Lambda::Function resources were found in the current template."}
          </p>
        ) : null}

        {sourceFiles.length > 0 ? (
          <ul className="source-file-list" aria-label="Selected source files">
            {sourceFiles.map((file) => (
              <li key={file.path}>
                <div className="source-file-details">
                  <span className="source-file-name">{file.path}</span>
                  <div className="source-file-mapping-controls">
                    <select
                      aria-label={`Lambda mapping for ${file.path}`}
                      className="source-file-mapping-select"
                      onChange={(event) => {
                        setSourceFiles((currentFiles) =>
                          currentFiles.map((currentFile) =>
                            currentFile.path === file.path
                              ? {
                                  ...currentFile,
                                  mappingSelection: event.target.value
                                }
                              : currentFile
                          )
                        );
                      }}
                      value={getMappingSelection(file, lambdaLogicalIds)}
                    >
                      <option value={autoDetectMappingValue}>Auto-detect</option>
                      <option value={sharedSourceMappingValue}>
                        Shared / not a Lambda handler
                      </option>
                      {lambdaLogicalIds.map((lambdaLogicalId) => (
                        <option key={lambdaLogicalId} value={lambdaLogicalId}>
                          {lambdaLogicalId}
                        </option>
                      ))}
                      <option value={manualMappingValue}>Manual ID...</option>
                    </select>
                    {getMappingSelection(file, lambdaLogicalIds) === manualMappingValue ? (
                      <input
                        aria-label={`Manual Lambda logical ID for ${file.path}`}
                        className="source-file-mapping-input"
                        onChange={(event) => {
                          setSourceFiles((currentFiles) =>
                            currentFiles.map((currentFile) =>
                              currentFile.path === file.path
                                ? {
                                    ...currentFile,
                                    manualLambdaFunctionId: event.target.value
                                  }
                                : currentFile
                            )
                          );
                        }}
                        placeholder="Lambda logical ID"
                        type="text"
                        value={file.manualLambdaFunctionId ?? ""}
                      />
                    ) : null}
                  </div>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    setSourceFiles((currentFiles) =>
                      currentFiles.filter((currentFile) => currentFile.path !== file.path)
                    );
                  }}
                  type="button"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-source-state">No source files selected.</p>
        )}
      </section>

      <div className="analyze-actions">
        <button
          className="primary-button"
          disabled={isLoading}
          onClick={() => {
            void handleAnalyze();
          }}
          type="button"
        >
          {isLoading ? "Analyzing..." : "Analyze"}
        </button>
      </div>

      {error !== null ? (
        <div className="error-message" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

function isAcceptedTemplateFile(fileName: string): boolean {
  const normalizedFileName = fileName.toLowerCase();

  return acceptedTemplateExtensions.some((extension) =>
    normalizedFileName.endsWith(extension)
  );
}

function isAcceptedSourceFile(fileName: string): boolean {
  const normalizedFileName = fileName.toLowerCase();

  return acceptedSourceExtensions.some((extension) =>
    normalizedFileName.endsWith(extension)
  );
}

function mergeSourceFiles(
  currentFiles: SourceFileInput[],
  uploadedFiles: UploadedSourceFileInput[]
): SourceFileInput[] {
  const filesByPath = new Map(currentFiles.map((file) => [file.path, file]));

  for (const file of uploadedFiles) {
    const currentFile = filesByPath.get(file.path);
    filesByPath.set(file.path, {
      ...file,
      mappingSelection: currentFile?.mappingSelection ?? autoDetectMappingValue,
      manualLambdaFunctionId: currentFile?.manualLambdaFunctionId
    });
  }

  return [...filesByPath.values()];
}

function toSourceFileMap(sourceFiles: SourceFileInput[]): Record<string, string> | undefined {
  if (sourceFiles.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sourceFiles.map((file) => [file.path, file.content]));
}

function toSourceFileMappings(
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

function toSourceFileExclusions(
  sourceFiles: SourceFileInput[],
  lambdaLogicalIds: string[]
): string[] | undefined {
  const exclusions = sourceFiles
    .filter((file) => getMappingSelection(file, lambdaLogicalIds) === sharedSourceMappingValue)
    .map((file) => file.path);

  return exclusions.length === 0 ? undefined : exclusions;
}

function getMappingSelection(file: SourceFileInput, lambdaLogicalIds: string[]): string {
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

function extractLambdaLogicalIds(templateInput: string): string[] {
  const jsonTemplate = tryParseJsonObject(templateInput);
  const lambdaLogicalIds =
    jsonTemplate === undefined
      ? extractLambdaLogicalIdsFromYaml(templateInput)
      : extractLambdaLogicalIdsFromObject(jsonTemplate);

  return [...new Set(lambdaLogicalIds)].sort((left, right) => left.localeCompare(right));
}

function extractLambdaLogicalIdsFromObject(template: Record<string, unknown>): string[] {
  const resources = template.Resources;

  if (!isRecord(resources)) {
    return [];
  }

  return Object.entries(resources).flatMap(([logicalId, resource]) =>
    isRecord(resource) && resource.Type === "AWS::Lambda::Function" ? [logicalId] : []
  );
}

function extractLambdaLogicalIdsFromYaml(templateInput: string): string[] {
  const lambdaLogicalIds = new Set<string>();
  let resourcesIndent: number | undefined;
  let currentResource: { logicalId: string; indent: number } | undefined;

  for (const line of templateInput.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const indent = getIndent(line);
    if (/^Resources\s*:/.test(trimmedLine)) {
      resourcesIndent = indent;
      currentResource = undefined;
      continue;
    }

    if (resourcesIndent === undefined) {
      continue;
    }

    if (indent <= resourcesIndent) {
      resourcesIndent = undefined;
      currentResource = undefined;
      continue;
    }

    const resourceMatch = trimmedLine.match(/^([A-Za-z0-9]+)\s*:\s*$/);
    if (resourceMatch !== null && indent > resourcesIndent) {
      currentResource = {
        logicalId: resourceMatch[1],
        indent
      };
      continue;
    }

    if (
      currentResource !== undefined &&
      indent > currentResource.indent &&
      /^Type\s*:\s*['"]?AWS::Lambda::Function['"]?\s*$/.test(trimmedLine)
    ) {
      lambdaLogicalIds.add(currentResource.logicalId);
    }
  }

  return [...lambdaLogicalIds];
}

function tryParseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsedValue = JSON.parse(value) as unknown;

    return isRecord(parsedValue) ? parsedValue : undefined;
  } catch {
    return undefined;
  }
}

function getIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
