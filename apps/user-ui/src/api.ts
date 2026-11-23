import { apiUrl } from "./config";
import { serverClock } from "./server-clock";

const API_HEADERS = { "content-type": "application/json" };

/** A failed response: the message stays the response text, and the status is kept for callers that branch on it. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** A failure as a person reads it: a JSON body's `error`, else a plain-text message, else the fallback. */
export function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message.trim()) return fallback;
  const text = error.message.trim();
  if (!text.startsWith("{")) return text;
  try {
    const value = JSON.parse(text) as { error?: unknown };
    return typeof value.error === "string" && value.error.trim() ? value.error : fallback;
  } catch { return text; }
}

export async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(apiUrl(path), { credentials: "include", ...init });
  serverClock.noteResponseDate(res);
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(text || `Request failed: ${res.status}`, res.status);
  }
  return res;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  return (await res.json()) as T;
}

export function getApiHeaders() {
  return API_HEADERS;
}
