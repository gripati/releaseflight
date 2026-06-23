import { CredentialInvalidError, NotFoundError, ConflictError, RateLimitError, UpstreamError, ValidationError } from "../../errors";
import type { AppleAuth, AppleCredentialMaterial } from "./AppleAuth";

const BASE_URL = "https://api.appstoreconnect.apple.com/v1";

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export interface ApplePaginatedResponse<T> {
  data: T[];
  links?: { next?: string; self?: string };
  meta?: { paging?: { total?: number; limit?: number } };
  included?: unknown[];
}

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Tenant-agnostic HTTP wrapper over App Store Connect API.
 * The caller is responsible for providing credential material and
 * holding the AppleAuth cache (typically a singleton per worker).
 */
export class AppleClient {
  constructor(
    private readonly auth: AppleAuth,
    private readonly cred: AppleCredentialMaterial,
  ) {}

  async request<T>(opts: RequestOptions): Promise<T> {
    const token = await this.auth.getToken(this.cred);
    const url = new URL(BASE_URL + opts.path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    opts.signal?.addEventListener("abort", () => controller.abort());

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      let body: BodyInit | undefined;
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }

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

      if (!res.ok) throw this.classifyError(res.status, parsed);
      return parsed as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new UpstreamError("apple", `Timed out after ${(opts.timeoutMs ?? 60_000).toString()}ms`, {
          httpStatus: 504,
          retryable: true,
        });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Raw-bytes variant of `request` — used for endpoints that return
   * gzipped TSV / CSV (e.g. /v1/salesReports). Returns null on 404 so
   * callers can treat "no data for that day" as a soft signal.
   */
  async requestRaw(opts: {
    path: string;
    query?: Record<string, string | number | undefined>;
    accept?: string;
    timeoutMs?: number;
  }): Promise<Buffer | null> {
    const token = await this.auth.getToken(this.cred);
    const url = new URL(BASE_URL + opts.path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: opts.accept ?? "application/a-gzip, application/json",
        },
        signal: controller.signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text();
        throw this.classifyError(res.status, safeJson(text));
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return buf;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Iterates the JSON:API `links.next` cursor up to `pageLimit` pages. */
  async *paginate<T>(opts: {
    path: string;
    query?: Record<string, string | number | undefined>;
    pageLimit?: number;
  }): AsyncIterableIterator<T> {
    const cap = opts.pageLimit ?? 50;
    let nextPath: string | undefined = opts.path;
    let firstPage = true;
    let pages = 0;

    while (nextPath && pages < cap) {
      const requestOpts: RequestOptions = { method: "GET", path: nextPath };
      if (firstPage && opts.query) requestOpts.query = opts.query;
      const page = await this.request<ApplePaginatedResponse<T>>(requestOpts);

      for (const item of page.data) yield item;
      pages += 1;

      const next = page.links?.next;
      if (!next) break;

      // Apple returns absolute URL; strip BASE_URL prefix
      if (next.startsWith(BASE_URL)) {
        nextPath = next.slice(BASE_URL.length);
      } else if (next.startsWith("/")) {
        nextPath = next;
      } else {
        break;
      }
      firstPage = false;
    }
  }

  private classifyError(status: number, body: unknown): Error {
    let detail = `Apple API error (HTTP ${status.toString()})`;
    const errors = (body as { errors?: { detail?: string; title?: string; code?: string }[] } | null)?.errors;
    const first = errors?.[0];
    if (first?.detail) detail = first.detail;
    else if (first?.title) detail = first.title;

    if (status === 400) return new ValidationError(detail, { provider: "apple", code: first?.code });
    if (status === 401 || status === 403) return new CredentialInvalidError(detail);
    if (status === 404) return new NotFoundError(detail);
    if (status === 409) return new ConflictError(detail);
    if (status === 429) return new RateLimitError(60);
    if (status >= 500) return new UpstreamError("apple", detail, { httpStatus: status, retryable: true });
    return new UpstreamError("apple", detail, { httpStatus: status });
  }
}
