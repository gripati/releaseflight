import { redis } from "./client";

/**
 * Best-effort cache helpers.
 *
 * Redis here is shared with the BullMQ job queue, so it runs with
 * `maxmemory-policy noeviction` (a queue key must never be silently evicted).
 * The flip side of noeviction is that once `maxmemory` is reached, writes are
 * REFUSED with an OOM error. Cache writes must therefore NEVER propagate that
 * error into a request — a full cache should degrade to a cache miss, not a 500.
 *
 * These wrappers swallow Redis errors (OOM, connection blips, timeouts):
 *  - `cacheGet` returns null on any error → treated as a miss.
 *  - `cacheSet` silently skips on any error → the value just isn't cached.
 *
 * Use these for genuine CACHE access only. Do NOT use them for the queue, locks,
 * rate-limiting, or anything where a dropped write is a correctness bug — those
 * must surface their errors.
 */

function warn(op: string, key: string, e: unknown): void {
  if (process.env.NODE_ENV === "test") return;
  const msg = e instanceof Error ? e.message : String(e);
  // Cache degradation is non-fatal; log at warn so it's visible without paging.
  console.warn(`[cache] ${op} degraded for "${key}": ${msg}`);
}

/** Best-effort GET. Returns the value, or null on miss OR any Redis error. */
export async function cacheGet(key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch (e) {
    warn("get", key, e);
    return null;
  }
}

/**
 * Best-effort SET with a TTL in seconds. Swallows Redis errors (incl. OOM under
 * noeviction) — the value simply isn't cached. Returns true if it was stored.
 */
export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  try {
    await redis.set(key, value, "EX", ttlSeconds);
    return true;
  } catch (e) {
    warn("set", key, e);
    return false;
  }
}

/** Best-effort DELETE. Swallows Redis errors. */
export async function cacheDel(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (e) {
    warn("del", key, e);
  }
}
