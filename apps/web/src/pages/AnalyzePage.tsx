import { useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { analyzeTemplate } from "../api/analyzeTemplate";
import { useAnalysisReport } from "../reportState";

const acceptedTemplateExtensions = [".json", ".yaml", ".yml"];
const acceptedSourceExtensions = [".ts", ".js", ".mjs", ".cjs"];

interface SourceFileInput {
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
        sourceFiles: toSourceFileMap(sourceFiles)
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

        {sourceFiles.length > 0 ? (
          <ul className="source-file-list" aria-label="Selected source files">
            {sourceFiles.map((file) => (
              <li key={file.path}>
                <span>{file.path}</span>
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
  uploadedFiles: SourceFileInput[]
): SourceFileInput[] {
  const filesByPath = new Map(currentFiles.map((file) => [file.path, file]));

  for (const file of uploadedFiles) {
    filesByPath.set(file.path, file);
  }

  return [...filesByPath.values()];
}

function toSourceFileMap(sourceFiles: SourceFileInput[]): Record<string, string> | undefined {
  if (sourceFiles.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sourceFiles.map((file) => [file.path, file.content]));
}
