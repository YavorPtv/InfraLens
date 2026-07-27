import type { AnalysisReport } from "@infralens/shared";

export interface AnalyzeTemplateRequest {
  templateInput: string;
  sourceFiles?: Record<string, string>;
  sourceFileMappings?: Record<string, string>;
  sourceFileExclusions?: string[];
}

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    detail?: string;
  };
}

const defaultApiBaseUrl = "http://localhost:3000";
const apiBaseUrl = import.meta.env.VITE_INFRALENS_API_BASE_URL ?? defaultApiBaseUrl;

export async function analyzeTemplate({
  templateInput,
  sourceFiles,
  sourceFileMappings,
  sourceFileExclusions
}: AnalyzeTemplateRequest): Promise<AnalysisReport> {
  const hasSourceFiles = sourceFiles !== undefined && Object.keys(sourceFiles).length > 0;
  const hasSourceFileMappings =
    sourceFileMappings !== undefined && Object.keys(sourceFileMappings).length > 0;
  const hasSourceFileExclusions =
    sourceFileExclusions !== undefined && sourceFileExclusions.length > 0;
  const hasRequestEnvelope =
    hasSourceFiles || hasSourceFileMappings || hasSourceFileExclusions;
  const response = await fetch(getAnalyzeUrl(apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": hasRequestEnvelope
        ? "application/json; charset=utf-8"
        : "text/plain; charset=utf-8"
    },
    body: hasRequestEnvelope
      ? JSON.stringify({
          template: templateInput,
          ...(sourceFiles === undefined ? {} : { sourceFiles }),
          ...(sourceFileMappings === undefined ? {} : { sourceFileMappings }),
          ...(sourceFileExclusions === undefined ? {} : { sourceFileExclusions })
        })
      : templateInput
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as AnalysisReport;
}

function getAnalyzeUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  if (normalizedBaseUrl.endsWith("/analyze")) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/analyze`;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorResponse;
    return payload.error?.detail ?? payload.error?.message ?? "Template analysis failed.";
  } catch {
    return "Template analysis failed.";
  }
}
