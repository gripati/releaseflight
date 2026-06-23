import { FilesystemStorage } from "./FilesystemStorage";
import { S3Storage } from "./S3Storage";
import type { StorageProvider } from "./StorageProvider";

export type StorageScope = "default";

let _instance: StorageProvider | undefined;

export function createStorage(): StorageProvider {
  if (_instance) return _instance;

  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;

  if (endpoint && bucket) {
    _instance = new S3Storage({
      bucket,
      region: process.env.S3_REGION,
      endpoint,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      ...(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : {}),
    });
  } else {
    _instance = new FilesystemStorage();
  }
  return _instance;
}

/** Lazily-resolved singleton (does NOT throw on import). */
export const storage: StorageProvider = new Proxy({} as StorageProvider, {
  get(_t, prop) {
    const inst = createStorage();
    const value = (inst as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === "function") return value.bind(inst);
    return value;
  },
});
