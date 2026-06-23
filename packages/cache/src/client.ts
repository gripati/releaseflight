import Redis from "ioredis";

function getUrl(): string {
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}

function singleton<T>(key: string, factory: () => T): T {
  const g = globalThis as unknown as Record<string, T>;
  if (!g[key]) g[key] = factory();
  return g[key];
}

export const redis: Redis = singleton(
  "__gp_redis__",
  () =>
    new Redis(getUrl(), {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    }),
);

/** Dedicated pub/sub subscriber connection (cannot be shared with command client). */
export const redisSubscriber: Redis = singleton(
  "__gp_redis_sub__",
  () =>
    new Redis(getUrl(), {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    }),
);

export const redisPublisher: Redis = singleton(
  "__gp_redis_pub__",
  () =>
    new Redis(getUrl(), {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    }),
);
