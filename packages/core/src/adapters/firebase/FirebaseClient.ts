import {
  ConflictError,
  CredentialInvalidError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "../../errors";
import type { GoogleAuth, GoogleCredentialMaterial } from "../google/GoogleAuth";

/**
 * Firebase App Distribution is part of the Google APIs family, so it reuses
 * the same service-account OAuth2 flow (`GoogleAuth`) — only the scope and
 * host differ. The service-account JSON is identical in shape to the Google
 * Play one (`client_email` / `private_key` / `project_id`).
 */
export const FIREBASE_SCOPES = {
  APP_DISTRIBUTION:
    "https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/cloud-platform",
} as const;

const API_HOST = "https://firebaseappdistribution.googleapis.com";

interface JsonRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Full path beginning with /v1/… */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class FirebaseClient {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly cred: GoogleCredentialMaterial,
  ) {}

  async getToken(): Promise<string> {
    return this.auth.getAccessToken(this.cred, FIREBASE_SCOPES.APP_DISTRIBUTION);
  }

  /** JSON request against the v1 API (poll / distribute / patch / list). */
  async request<T>(opts: JsonRequest): Promise<T> {
    const token = await this.getToken();
    const url = new URL(API_HOST + opts.path);
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
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
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
      if (!res.ok) throw classifyError(res.status, parsed);
      return parsed as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new UpstreamError("firebase", `Timed out after ${(opts.timeoutMs ?? 30_000).toString()}ms`, {
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
   * Raw binary upload of an artifact (IPA / APK / AAB) to the upload host,
   * using the resumable-upload "raw" protocol. Returns the long-running
   * operation name to poll.
   */
  async uploadBinary(opts: {
    projectNumber: string;
    firebaseAppId: string;
    body: Buffer;
    fileName: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ operationName: string }> {
    const token = await this.getToken();
    const url =
      `${API_HOST}/upload/v1/projects/${opts.projectNumber}` +
      `/apps/${opts.firebaseAppId}/releases:upload`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15 * 60_000);
    opts.signal?.addEventListener("abort", () => controller.abort());

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "X-Goog-Upload-Protocol": "raw",
          "X-Goog-Upload-File-Name": opts.fileName,
        },
        body: opts.body as unknown as BodyInit,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (!res.ok) throw classifyError(res.status, parsed);
      const name = (parsed as { name?: string } | null)?.name;
      if (!name) {
        throw new UpstreamError("firebase", "Upload response missing operation name");
      }
      return { operationName: name };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new UpstreamError("firebase", "Upload timed out", { httpStatus: 504, retryable: true });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function classifyError(status: number, body: unknown): Error {
  const err = (body as { error?: { message?: string; status?: string } } | null)?.error;
  const message = err?.message ?? `Firebase API error (HTTP ${status.toString()})`;
  if (status === 400) return new ValidationError(message);
  if (status === 401) return new CredentialInvalidError(message);
  if (status === 403) return new CredentialInvalidError(message);
  if (status === 404) return new NotFoundError(message);
  if (status === 409) return new ConflictError(message);
  if (status === 429) return new RateLimitError(60);
  if (status >= 500) return new UpstreamError("firebase", message, { httpStatus: status, retryable: true });
  return new UpstreamError("firebase", message, { httpStatus: status });
}
