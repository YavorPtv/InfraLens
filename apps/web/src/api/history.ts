import { authenticatedFetch } from "../auth/authClient";
import { createHistoryClient } from "./historyClient";

export const historyClient = createHistoryClient(
  import.meta.env.VITE_INFRALENS_API_BASE_URL ?? "http://localhost:3000",
  authenticatedFetch
);

/** Preserve a retry key across reloads without storing submitted source/template content. */
export async function saveRequestKey(
  project: string,
  input: unknown,
  retainSource: boolean
): Promise<string> {
  const serializedRequest = JSON.stringify({ project, input, retainSource });
  const encodedRequest = new TextEncoder().encode(serializedRequest);
  const digest = await crypto.subtle.digest("SHA-256", encodedRequest);
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const slot = `infralens-save-${project}`;
  let stored: {
    fingerprint?: string;
    key?: string;
  } = {};
  try {
    stored = JSON.parse(sessionStorage.getItem(slot) ?? "{}");
  } catch {
    /* Replace invalid draft metadata. */
  }
  if (stored.fingerprint === fingerprint && stored.key) {
    return stored.key;
  }
  const key = crypto.randomUUID();
  sessionStorage.setItem(
    slot,
    JSON.stringify({
      fingerprint,
      key
    })
  );
  return key;
}
