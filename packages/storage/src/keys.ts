import { ValidationError } from "@marquee/core";

const UUID_RE = /^[0-9a-f-]{36}$/i;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Compose a storage key inside the tenant's namespace. Each `extra` segment
 * is validated against [A-Za-z0-9._-]+ so user input cannot escape the
 * tenant prefix or inject a slash. Use this helper EVERY time you build a
 * storage key — never concatenate strings manually.
 */
export function tenantStorageKey(
  tenantId: string,
  ...extra: string[]
): string {
  if (!UUID_RE.test(tenantId)) {
    throw new ValidationError("tenantId must be a UUID");
  }
  const parts = ["tenants", tenantId];
  for (const seg of extra) {
    if (!seg) continue;
    if (seg === "." || seg === ".." || !SAFE_SEGMENT_RE.test(seg)) {
      throw new ValidationError(`Unsafe storage segment: ${seg}`);
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Scratch namespace — TTL 1 hour. Used for in-flight uploads that have
 * not yet been committed to a permanent location.
 */
export function tenantScratchKey(tenantId: string, ...extra: string[]): string {
  if (!UUID_RE.test(tenantId)) {
    throw new ValidationError("tenantId must be a UUID");
  }
  const parts = ["scratch", tenantId];
  for (const seg of extra) {
    if (!seg) continue;
    if (seg === "." || seg === ".." || !SAFE_SEGMENT_RE.test(seg)) {
      throw new ValidationError(`Unsafe storage segment: ${seg}`);
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Verifies a key belongs to the given tenant. Used by the storage proxy
 * route as defence in depth before serving a signed URL.
 */
export function parseStorageKey(key: string): { tenantId: string | null; rest: string[] } {
  if (!key) return { tenantId: null, rest: [] };
  const segs = key.split("/").filter(Boolean);
  if (segs.length < 2 || segs[0] !== "tenants") return { tenantId: null, rest: segs };
  return { tenantId: segs[1] ?? null, rest: segs.slice(2) };
}
