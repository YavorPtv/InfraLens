import { useRef, useState, type ChangeEvent } from "react";
import type { SourceAnalysisInput } from "@infralens/shared";
import {
  acceptedSourceExtensions, autoDetectMappingValue, manualMappingValue, sharedSourceMappingValue,
  mergeSourceFiles, readSourceUploads, toSourceFileMappings, toSourceFileExclusions, type SourceFileInput
} from "../sourceFiles";

export function SourceContextInput({ label, value, onChange, onReadingChange }: {
  label: string;
  value: SourceAnalysisInput | undefined;
  onChange: (value: SourceAnalysisInput | undefined) => void;
  onReadingChange: (reading: boolean) => void;
}) {
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("");
  const [files, setFiles] = useState<SourceFileInput[]>(() => Object.entries(value?.sourceFiles ?? {}).map(([path, content]) => ({
    path, content, uploadStatus: "added",
    mappingSelection: value?.sourceFileExclusions?.includes(path) ? sharedSourceMappingValue :
      value?.sourceFileMappings?.[path] ? manualMappingValue : autoDetectMappingValue,
    manualLambdaFunctionId: value?.sourceFileMappings?.[path]
  })));
  function update(next: SourceFileInput[]) {
    setFiles(next);
    onChange({ sourceFiles: Object.fromEntries(next.map(file => [file.path, file.content])),
      sourceFileMappings: toSourceFileMappings(next, []), sourceFileExclusions: toSourceFileExclusions(next, []) });
  }
  async function upload(event: ChangeEvent<HTMLInputElement>, folder = false) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selected.length) return;
    setReading(true);
    onReadingChange(true);
    try {
      const uploaded = await readSourceUploads(selected, folder);
      const merged = mergeSourceFiles(files, uploaded.files);
      update(merged);
      setNotice(`${uploaded.files.length} files read; ${merged.filter(file => file.uploadStatus === "replaced").length} replaced; ${uploaded.ignoredCount} skipped.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Source upload failed.");
    } finally {
      setReading(false);
      onReadingChange(false);
    }
  }
  return <section className="source-upload-panel" aria-label={`${label} source context`}>
    <h3>{label} source context</h3>
    <p className="muted-note">Optional JS/TS files or folder. Relative paths are preserved. Same paths belong independently to each side.</p>
    <label><input type="checkbox" checked={value?.sourceFiles !== undefined} disabled={reading}
      onChange={event => { setFiles([]); onChange(event.target.checked ? { sourceFiles: {} } : undefined); }} /> Include source tree</label>
    <p className="muted-note">{value?.sourceFiles === undefined ? "Source missing: template-only analysis." : `${files.length} files in analyzed tree (an empty tree is explicit).`}</p>
    <div className="source-upload-actions">
      <input aria-label={`${label} source files`} className="file-input" type="file" multiple
        accept={acceptedSourceExtensions.join(",")} ref={filesInput} onChange={event => void upload(event)} />
      <button type="button" className="secondary-button" disabled={reading} onClick={() => filesInput.current?.click()}>Upload source files</button>
      <input aria-label={`${label} source folder`} className="file-input" type="file" multiple
        {...{ webkitdirectory: "" }} ref={folderInput} onChange={event => void upload(event, true)} />
      <button type="button" className="secondary-button" disabled={reading} onClick={() => folderInput.current?.click()}>Upload source folder</button>
    </div>
    <p className="muted-note">Per side: 100 files, 256 KiB per file; both source trees together: 2 MiB. Request: 4 MiB including templates and metadata.</p>
    {notice && <p role="status">{notice}</p>}
    <ul className="source-file-list">{files.map(file => <li key={file.path}>
      <strong>{file.path}</strong>
      <label> Lambda mapping <select aria-label={`${label} mapping for ${file.path}`} value={file.mappingSelection} disabled={reading}
        onChange={event => update(files.map(current => current.path === file.path ?
          { ...current, mappingSelection: event.target.value } : current))}>
        <option value={autoDetectMappingValue}>Auto detect</option>
        <option value={sharedSourceMappingValue}>Shared helper (exclude as root)</option>
        <option value={manualMappingValue}>Explicit Lambda logical ID</option>
      </select></label>
      {file.mappingSelection === manualMappingValue && <input aria-label={`${label} Lambda logical ID for ${file.path}`}
        placeholder="Lambda logical ID" value={file.manualLambdaFunctionId ?? ""} disabled={reading}
        onChange={event => update(files.map(current => current.path === file.path ?
          { ...current, manualLambdaFunctionId: event.target.value } : current))} />}
      <button className="secondary-button" type="button" disabled={reading} onClick={() => update(files.filter(current => current.path !== file.path))}>Remove</button>
    </li>)}</ul>
  </section>;
}
