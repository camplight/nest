import { apiUrl } from "./config";

const API_HEADERS = { "content-type": "application/json" };

/** A failed response: the message stays the response text, and the status is kept for callers that branch on it. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(apiUrl(path), { credentials: "include", ...init });
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
