import { createAppleEs256Jwt } from "../../crypto/apple-jwt";
import { CredentialInvalidError, UpstreamError } from "../../errors";

export interface AppleCredentialMaterial {
  /** Identifier shared between in-memory cache and Redis (usually credentialId UUID). */
  id: string;
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
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
 * App Store Connect authentication. Generates ES256 JWTs and caches them
 * both in-process (short-lived) and optionally in Redis (cross-process).
 *
 * Apple JWTs are valid up to 20 minutes. We refresh 5 minutes before expiry.
 */
export class AppleAuth {
  private readonly memoryCache = new Map<string, CachedToken>();

  constructor(private readonly redis?: AsyncCache) {}

  async getToken(cred: AppleCredentialMaterial): Promise<string> {
    const cacheKey = `apple:${cred.id}:${cred.keyId}`;
    const now = Date.now();

    // L1: in-process
    const local = this.memoryCache.get(cacheKey);
    if (local && local.expiresAt > now + 60_000) {
      return local.token;
    }

    // L2: Redis (shared across workers)
    if (this.redis) {
      const remote = await this.redis.get(cacheKey);
      if (remote) {
        // Re-validate by quickly checking expiry — we assume Redis TTL is honest
        this.memoryCache.set(cacheKey, { token: remote, expiresAt: now + 14 * 60 * 1000 });
        return remote;
      }
    }

    // Mint a fresh JWT
    const token = createAppleEs256Jwt({
      keyId: cred.keyId,
      issuerId: cred.issuerId,
      privateKeyPem: cred.privateKeyPem,
      ttlSeconds: 1200,
    });

    const expiresAt = now + 14 * 60 * 1000; // 14 min — conservatively under 20-min Apple cap
    this.memoryCache.set(cacheKey, { token, expiresAt });
    if (this.redis) {
      await this.redis.set(cacheKey, token, 14 * 60);
    }
    return token;
  }

  /**
   * Lightweight test: mint a token + GET /apps?limit=1.
   * Returns a structured outcome instead of throwing so the UI can render it.
   */
  async testConnection(
    cred: AppleCredentialMaterial,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ ok: boolean; message: string }> {
    let token: string;
    try {
      token = createAppleEs256Jwt({
        keyId: cred.keyId,
        issuerId: cred.issuerId,
        privateKeyPem: cred.privateKeyPem,
        ttlSeconds: 600,
      });
    } catch (err: unknown) {
      if (err instanceof CredentialInvalidError) return { ok: false, message: err.message };
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort());

    try {
      const res = await fetch("https://api.appstoreconnect.apple.com/v1/apps?limit=1", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.ok) return { ok: true, message: "Connected" };

      const text = await res.text();
      let detail = `HTTP ${res.status.toString()}`;
      try {
        const json = JSON.parse(text) as { errors?: { detail?: string; title?: string }[] };
        const first = json.errors?.[0];
        if (first?.detail) detail = first.detail;
        else if (first?.title) detail = first.title;
      } catch {
        // text/plain error body
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Credential rejected by Apple: ${detail}` };
      }
      return { ok: false, message: detail };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, message: "Timed out reaching Apple (10s)" };
      }
      throw new UpstreamError("apple", err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeout);
    }
  }
}
