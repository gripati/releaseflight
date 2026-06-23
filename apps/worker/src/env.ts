/**
 * Loads the monorepo-root `.env` into `process.env` BEFORE any other worker
 * module evaluates.
 *
 * The worker is a standalone Node process (not Next.js), so nothing else loads
 * `.env` for it. Without this it starts with no `SECRETS_ENCRYPTION_KEY` /
 * `SECRETS_DIR` / `DATABASE_URL` / `REDIS_URL`, and the first credential it
 * decrypts (e.g. the OpenAI/Astro ASO key, or a store service-account) fails
 * with: "SECRETS_ENCRYPTION_KEY is required to read this encrypted secret."
 *
 * MUST be the first import in `index.ts` so it runs before `@marquee/secrets`
 * constructs its provider singleton (which reads the key at construction).
 *
 * The path is resolved from THIS file's location (`../../../.env` whether it
 * runs from `src/` under tsx or `dist/` under node), so it is independent of
 * the process CWD. Loading is best-effort: a CI/container deploy that injects
 * real env vars directly can omit the file.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(here, "../../../.env");

try {
  process.loadEnvFile(rootEnv);
} catch {
  // .env absent/unreadable — expected when the environment is provided directly.
}
