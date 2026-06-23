import { redis } from "./client";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
  limit: number;
}

/**
 * Fixed-window per-minute rate limiter. Lower bound is good enough for
 * abuse protection; for finer guarantees use sliding-window in V1.5.
 *
 * Returns `{ allowed: false, resetSeconds }` when the bucket is exhausted.
 */
export async function rateLimit(opts: {
  key: string;
  limit: number;
  windowSeconds?: number;
}): Promise<RateLimitResult> {
  const window = opts.windowSeconds ?? 60;
  const pipeline = redis.multi();
  pipeline.incr(opts.key);
  pipeline.expire(opts.key, window, "NX");
  pipeline.ttl(opts.key);
  const results = await pipeline.exec();
  if (!results) {
    // Redis failure — fail open so the app keeps working
    return { allowed: true, remaining: opts.limit, resetSeconds: window, limit: opts.limit };
  }
  const countRaw = results[0]?.[1] as number | null;
  const ttlRaw = results[2]?.[1] as number | null;
  const count = countRaw ?? 0;
  const ttl = (ttlRaw ?? -1) < 0 ? window : (ttlRaw ?? window);
  const remaining = Math.max(0, opts.limit - count);
  return {
    allowed: count <= opts.limit,
    remaining,
    resetSeconds: ttl,
    limit: opts.limit,
  };
}
