import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { analyzeTemplate } from "../api/analyzeTemplate";
import { useAnalysisReport } from "../reportState";
import {
  acceptedSourceExtensions, autoDetectMappingValue, sharedSourceMappingValue, manualMappingValue,
  getMappingSelection, mergeSourceFiles, readSourceUploads, removeSourceFile,
  toSourceFileMap, toSourceFileMappings, toSourceFileExclusions, type SourceFileInput
} from "../sourceFiles";

const acceptedTemplateExtensions = [".json", ".yaml", ".yml"];

export function AnalyzePage() {
  const [templateInput, setTemplateInput] = useState("");
  const [sourceFiles, setSourceFiles] = useState<SourceFileInput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isReadingSources, setIsReadingSources] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);
  const sourceFolderInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const { setOriginalTemplateInput, setReport } = useAnalysisReport();
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

  async function handleSourceFileChange(event: ChangeEvent<HTMLInputElement>, folderUpload = false): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length === 0) {
      return;
    }

    setIsReadingSources(true);
    setUploadNotice(null);
    try {
      const uploaded = await readSourceUploads(files, folderUpload);
      setSourceFiles((currentFiles) => mergeSourceFiles(currentFiles, uploaded.files));
      setUploadNotice(
        `${uploaded.files.length} source files read. ${uploaded.ignoredCount} unsupported or dependency files skipped. ` +
        "Existing paths are marked Replaced; their mappings are kept."
      );
      setError(null);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Source files could not be read.");
    } finally {
      setIsReadingSources(false);
    }
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
      setOriginalTemplateInput(templateInput);
      navigate("/report");
    } catch (analysisError) {
      setReport(null);
      setOriginalTemplateInput(null);
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
          <p className="muted-note">
            Upload a project folder to keep relative paths, including the selected folder name.
            Individual files may provide only a filename. Uploading the same path replaces its content
            and keeps its Lambda mapping. Folder uploads skip unsupported files, node_modules, and .git.
          </p>
        </div>

        <div className="source-upload-actions">
          <input
            accept={acceptedSourceExtensions.join(",")}
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
            disabled={isReadingSources || isLoading}
            onClick={() => sourceFileInputRef.current?.click()}
            type="button"
          >
            Upload Source Files
          </button>
          <input
            className="file-input"
            id="source-folder"
            multiple
            {...{ webkitdirectory: "" }}
            onChange={(event) => { void handleSourceFileChange(event, true); }}
            ref={sourceFolderInputRef}
            type="file"
          />
          <button
            className="secondary-button"
            disabled={isReadingSources || isLoading}
            onClick={() => sourceFolderInputRef.current?.click()}
            type="button"
          >
            Upload Source Folder
          </button>
          {sourceFiles.length > 0 ? (
            <button
              className="secondary-button"
              disabled={isReadingSources || isLoading}
              onClick={() => { setSourceFiles([]); setUploadNotice(null); }}
              type="button"
            >
              Clear Files
            </button>
          ) : null}
        </div>

        {uploadNotice !== null ? <p className="muted-note" role="status">{uploadNotice}</p> : null}
        {isReadingSources ? <p className="muted-note" role="status">Reading source files...</p> : null}

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
                  <span className="muted-note">{file.uploadStatus === "replaced" ? "Replaced (mapping kept)" : "Added"}</span>
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
                  aria-label={`Remove ${file.path}`}
                  disabled={isReadingSources || isLoading}
                  onClick={() => {
                    setSourceFiles((currentFiles) =>
                      removeSourceFile(currentFiles, file.path)
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
          disabled={isLoading || isReadingSources}
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
