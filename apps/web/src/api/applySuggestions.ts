import type { ApplySuggestionsResult, TemplateFix } from "@infralens/shared";

interface ApplySuggestionsRequest {
  templateInput: string;
  fixes: TemplateFix[];
}

interface ApiErrorResponse {
  error?: {
    message?: string;
    detail?: string;
  };
}

const defaultApiBaseUrl = "http://localhost:3000";
const apiBaseUrl = import.meta.env.VITE_INFRALENS_API_BASE_URL ?? defaultApiBaseUrl;

export async function applySuggestions({
  templateInput,
  fixes
}: ApplySuggestionsRequest): Promise<ApplySuggestionsResult> {
  const response = await fetch(getApplyUrl(apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      template: templateInput,
      fixes
    })
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as ApplySuggestionsResult;
}

function getApplyUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return normalizedBaseUrl.endsWith("/apply")
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/apply`;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorResponse;
    return payload.error?.detail ?? payload.error?.message ?? "Applying suggestions failed.";
  } catch {
    return "Applying suggestions failed.";
  }
}
