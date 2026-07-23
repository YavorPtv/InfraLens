import type { AnalysisReport } from "@infralens/shared";

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    detail?: string;
  };
}

const defaultApiBaseUrl = "http://localhost:3000";
const apiBaseUrl = import.meta.env.VITE_INFRALENS_API_BASE_URL ?? defaultApiBaseUrl;

export async function analyzeTemplate(templateInput: string): Promise<AnalysisReport> {
  const response = await fetch(getAnalyzeUrl(apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    },
    body: templateInput
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
