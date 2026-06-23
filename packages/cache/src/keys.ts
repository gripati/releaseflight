import { getCurrentTenantId } from "@marquee/db";

/**
 * Centralised Redis key builder. Every helper enforces tenant scoping by
 * embedding the active tenantId from AsyncLocalStorage. An ESLint rule
 * blocks direct `redis.get/set` calls with literal keys to ensure this
 * helper is the ONLY way to construct keys.
 *
 * Tenant-agnostic keys (e.g. global session) live under the `global:` prefix.
 */
export const cacheKey = {
  // Upstream API tokens (per credential, scoped by tenant)
  appleToken: (credentialId: string): string =>
    `apple:token:${getCurrentTenantId()}:${credentialId}`,
  googleToken: (credentialId: string, scope: string): string =>
    `google:token:${getCurrentTenantId()}:${credentialId}:${scope}`,

  // Rate limits — sliding window (minute granularity)
  rateLimitUser: (userId: string, minute: number): string =>
    `ratelimit:user:${getCurrentTenantId()}:${userId}:${minute.toString()}`,
  rateLimitAction: (action: string, identifier: string, minute: number): string =>
    `ratelimit:act:${getCurrentTenantId()}:${action}:${identifier}:${minute.toString()}`,

  // Idempotency
  idempotency: (key: string): string => `idem:${getCurrentTenantId()}:${key}`,

  // Distributed locks
  googleEditLock: (packageName: string): string =>
    `lock:google-edit:${getCurrentTenantId()}:${packageName}`,
  aabUploadLock: (packageName: string): string =>
    `lock:aab-upload:${getCurrentTenantId()}:${packageName}`,

  // Pub/sub channels — jobs SSE
  jobChannel: (jobId: string): string => `jobs:${getCurrentTenantId()}:${jobId}`,
  jobHistory: (jobId: string): string => `jobs:${getCurrentTenantId()}:${jobId}:hist`,

  // Cached metadata (TTL 30s — pull from store cache)
  appMetadataCache: (appId: string): string =>
    `cache:metadata:${getCurrentTenantId()}:${appId}`,
};

/** Tenant-agnostic keys (used in middleware before tenant context exists). */
export const globalKey = {
  // Sessions are tenant-agnostic because a user may switch tenants
  session: (sessionTokenHash: string): string => `global:session:${sessionTokenHash}`,
  // IP-based rate limit (applied before auth)
  rateLimitIp: (ip: string, minute: number): string =>
    `global:ratelimit:ip:${ip}:${minute.toString()}`,
  // Login attempt counter per email (auth brute-force)
  rateLimitLogin: (email: string, minute: number): string =>
    `global:ratelimit:login:${email}:${minute.toString()}`,
};
