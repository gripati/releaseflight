/**
 * Browser API client. Reads CSRF cookie and injects header automatically,
 * normalises error shapes into a typed result.
 */

const CSRF_COOKIE = "gp_csrf";

export interface ApiSuccess<T> { ok: true; data: T; status: number }
export interface ApiFailure { ok: false; status: number; code: string; message: string; details?: unknown }
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

async function ensureCsrfToken(): Promise<string | null> {
  const existing = readCookie(CSRF_COOKIE);
  if (existing) return existing;
  const res = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
  if (!res.ok) return null;
  const data = (await res.json()) as { csrfToken: string };
  return data.csrfToken;
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<ApiResult<T>> {
  const method = opts.method ?? "GET";
  const isMutating = method !== "GET";
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (isMutating) {
    const csrf = await ensureCsrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

  const res = await fetch(path, {
    method,
    headers,
    credentials: "include",
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* no body */
  }

  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    return {
      ok: false,
      status: res.status,
      code: err?.code ?? "UNKNOWN",
      message: err?.message ?? `Request failed (${res.status.toString()})`,
      details: err?.details,
    };
  }
  return { ok: true, status: res.status, data: payload as T };
}
