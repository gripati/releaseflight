import { createGoogleServiceAccountJwt } from "../../crypto/google-jwt";
import { CredentialInvalidError, UpstreamError } from "../../errors";

export const GOOGLE_SCOPES = {
  ANDROID_PUBLISHER: "https://www.googleapis.com/auth/androidpublisher",
} as const;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export interface GoogleCredentialMaterial {
  id: string;
  clientEmail: string;
  privateKeyPem: string;
  projectId?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface AsyncCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/**
 * Google OAuth2 service-account flow for the Google Play Publisher API.
 *
 * Tokens are cached 55 minutes (Google issues 60-minute tokens; we leave
 * 5 minutes safety).
 */
export class GoogleAuth {
  private readonly memoryCache = new Map<string, CachedToken>();

  constructor(private readonly redis?: AsyncCache) {}

  async getAccessToken(cred: GoogleCredentialMaterial, scope: string): Promise<string> {
    const cacheKey = `google:${cred.id}:${scope}`;
    const now = Date.now();

    const local = this.memoryCache.get(cacheKey);
    if (local && local.expiresAt > now + 60_000) {
      return local.token;
    }

    if (this.redis) {
      try {
        const remote = await this.redis.get(cacheKey);
        if (remote) {
          this.memoryCache.set(cacheKey, { token: remote, expiresAt: now + 50 * 60 * 1000 });
          return remote;
        }
      } catch {
        // Best-effort cache: a Redis miss/error must not block minting a token.
      }
    }

    const jwt = createGoogleServiceAccountJwt({
      clientEmail: cred.clientEmail,
      privateKeyPem: cred.privateKeyPem,
      scope,
      audience: TOKEN_URL,
      ttlSeconds: 3600,
    });

    const params = new URLSearchParams({ grant_type: GRANT_TYPE, assertion: jwt });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new CredentialInvalidError(
        `Google token exchange failed: HTTP ${res.status.toString()} ${text}`,
      );
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new CredentialInvalidError("Google token response missing access_token");
    }

    const expiresIn = Math.max(60, (data.expires_in ?? 3600) - 300);
    const ttlMs = expiresIn * 1000;

    this.memoryCache.set(cacheKey, { token: data.access_token, expiresAt: now + ttlMs });
    if (this.redis) {
      try {
        await this.redis.set(cacheKey, data.access_token, expiresIn);
      } catch {
        // Best-effort cache: token is already returned + memory-cached.
      }
    }
    return data.access_token;
  }

  async testConnection(
    cred: GoogleCredentialMaterial,
    scope: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ ok: boolean; message: string }> {
    try {
      await this.getAccessToken(cred, scope);
      return { ok: true, message: "Connected" };
    } catch (err: unknown) {
      if (err instanceof CredentialInvalidError) {
        return { ok: false, message: err.message };
      }
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, message: "Timed out reaching Google" };
      }
      throw new UpstreamError("google", err instanceof Error ? err.message : String(err));
    } finally {
      if (opts.signal?.aborted) {
        // No-op: included for symmetry with AppleAuth signature
      }
    }
  }
}
