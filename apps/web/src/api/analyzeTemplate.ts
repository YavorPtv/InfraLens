import type { AnalysisReport, TemplateValidationResult, AnalysisStatus } from "@infralens/shared";
import { authenticatedFetch } from "../auth/authClient";
import { serializeAnalyzeRequest, type AnalyzeTemplateRequest } from "./analyzeRequest";
export type { AnalyzeTemplateRequest } from "./analyzeRequest";

export class TemplateAnalysisError extends Error {
  constructor(message: string, readonly validation?: TemplateValidationResult, readonly analysisStatus?: AnalysisStatus) { super(message); }
}

interface ApiErrorResponse {
  error?: {
    validation?: TemplateValidationResult;
    analysisStatus?: AnalysisStatus;
    code?: string;
    message?: string;
    detail?: string;
  };
}

const defaultApiBaseUrl = "http://localhost:3000";
const apiBaseUrl = import.meta.env.VITE_INFRALENS_API_BASE_URL ?? defaultApiBaseUrl;

export async function analyzeTemplate(request: AnalyzeTemplateRequest): Promise<AnalysisReport> {
  const serialized = serializeAnalyzeRequest(request);
  const response = await authenticatedFetch(getAnalyzeUrl(apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": serialized.contentType
    },
    body: serialized.body
  });

  if (!response.ok) {
    throw await readAnalysisError(response);
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

async function readAnalysisError(response: Response): Promise<TemplateAnalysisError> {
  try {
    const payload = (await response.json()) as ApiErrorResponse;
    return new TemplateAnalysisError(payload.error?.detail ?? payload.error?.message ?? "Template analysis failed.", payload.error?.validation, payload.error?.analysisStatus);
  } catch {
    return new TemplateAnalysisError("Template analysis failed.");
  }
}
