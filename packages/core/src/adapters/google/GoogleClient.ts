import { ConflictError, CredentialInvalidError, NotFoundError, RateLimitError, UpstreamError, ValidationError } from "../../errors";
import type { GoogleAuth, GoogleCredentialMaterial } from "./GoogleAuth";

const BASE_URL = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown | Buffer;
  contentType?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  silent?: boolean;
}

export class GoogleClient {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly cred: GoogleCredentialMaterial,
    private readonly scope: string,
  ) {}

  async getToken(): Promise<string> {
    return this.auth.getAccessToken(this.cred, this.scope);
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const token = await this.getToken();
    const url = new URL(BASE_URL + opts.path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    opts.signal?.addEventListener("abort", () => controller.abort());

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: BodyInit | undefined;
    if (opts.body !== undefined && opts.body !== null) {
      if (Buffer.isBuffer(opts.body)) {
        headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
        body = opts.body as unknown as BodyInit;
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
    }

    try {
      const res = await fetch(url.toString(), {
        method: opts.method,
        headers,
        body,
        signal: controller.signal,
      });

      if (res.status === 204) return undefined as T;

      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      if (!res.ok) throw this.classifyError(res.status, parsed, opts.silent);
      return parsed as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new UpstreamError("google", `Timed out after ${(opts.timeoutMs ?? 30_000).toString()}ms`, {
          httpStatus: 504,
          retryable: true,
        });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private classifyError(status: number, body: unknown, silent?: boolean): Error {
    const err = (body as { error?: { message?: string; errors?: { reason?: string }[] } } | null)?.error;
    const message = err?.message ?? `Google API error (HTTP ${status.toString()})`;
    const reason = err?.errors?.[0]?.reason;

    if (!silent && status >= 500) {
      // Caller may log; we just return a typed error
    }

    if (status === 400) return new ValidationError(message);
    if (status === 401) return new CredentialInvalidError(message);
    if (status === 403) {
      if (reason === "quotaExceeded" || /quota/i.test(message)) {
        return new RateLimitError(60);
      }
      return new CredentialInvalidError(message);
    }
    if (status === 404) return new NotFoundError(message);
    if (status === 409) return new ConflictError(message);
    if (status === 429) return new RateLimitError(60);
    if (status >= 500) return new UpstreamError("google", message, { httpStatus: status, retryable: true });
    return new UpstreamError("google", message, { httpStatus: status });
  }
}
