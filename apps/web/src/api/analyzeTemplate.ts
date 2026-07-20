import type { AnalysisReport } from "@infralens/shared";

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    detail?: string;
  };
}

const apiBaseUrl = import.meta.env.VITE_INFRALENS_API_BASE_URL ?? "http://localhost:3000";

export async function analyzeTemplate(templateJson: string): Promise<AnalysisReport> {
  const response = await fetch(`${apiBaseUrl}/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: templateJson
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as AnalysisReport;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorResponse;
    return payload.error?.detail ?? payload.error?.message ?? "Template analysis failed.";
  } catch {
    return "Template analysis failed.";
  }
}
