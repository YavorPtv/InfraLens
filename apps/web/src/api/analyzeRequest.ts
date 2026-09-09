import { normalizeSourceAnalysisInput, type AnalyzeApiRequest, type SourceAnalysisInput } from "@infralens/shared";

export interface AnalyzeTemplateRequest extends SourceAnalysisInput {
  templateInput: string;
}

/** Shared by the browser client and non-browser workflow tests. */
export function serializeAnalyzeRequest(request: AnalyzeTemplateRequest): { body: string; contentType: string } {
  const source = normalizeSourceAnalysisInput(request);
  const hasSource = Object.keys(source.sourceFiles ?? {}).length > 0 ||
    Object.keys(source.sourceFileMappings ?? {}).length > 0 || (source.sourceFileExclusions?.length ?? 0) > 0;
  const envelope: AnalyzeApiRequest = { template: request.templateInput, ...source };
  return {
    body: hasSource ? JSON.stringify(envelope) : request.templateInput,
    contentType: hasSource ? "application/json; charset=utf-8" : "text/plain; charset=utf-8"
  };
}
