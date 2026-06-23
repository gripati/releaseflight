import { randomUUID } from "node:crypto";
import { ConflictError } from "@marquee/core";
import { redis } from "./client";

export interface LockHandle {
  key: string;
  value: string;
  release: () => Promise<void>;
}

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/**
 * Acquires a tenant-scoped distributed lock. Throws ConflictError when
 * another holder owns the key. Use `withLock` for the safer try/finally
 * pattern.
 */
export async function acquireLock(
  key: string,
  ttlMs = 600_000,
): Promise<LockHandle> {
  const value = randomUUID();
  const result = await redis.set(key, value, "PX", ttlMs, "NX");
  if (result !== "OK") {
    throw new ConflictError(`Lock already held: ${key}`);
  }
  return {
    key,
    value,
    release: async () => {
      await releaseLock(key, value);
    },
  };
}

export async function releaseLock(key: string, value: string): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, key, value);
}

export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await acquireLock(key, ttlMs);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
