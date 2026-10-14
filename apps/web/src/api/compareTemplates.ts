import type { DiffReport } from "@infralens/shared";
import { authenticatedFetch } from "../auth/authClient";
import { serializeCompareRequest, type CompareNavigationState } from "../compareInput";

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    detail?: string;
  };
}

const defaultApiBaseUrl = "http://localhost:3000";
const apiBaseUrl = import.meta.env.VITE_INFRALENS_API_BASE_URL ?? defaultApiBaseUrl;

export async function compareTemplates(input: CompareNavigationState): Promise<DiffReport> {
  const response = await authenticatedFetch(getDiffUrl(apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(serializeCompareRequest(input))
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as DiffReport;
}

function getDiffUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  if (normalizedBaseUrl.endsWith("/diff")) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/diff`;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorResponse;
    return payload.error?.detail ?? payload.error?.message ?? "Template comparison failed.";
  } catch {
    return "Template comparison failed.";
  }
}
