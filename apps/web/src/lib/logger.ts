import pino, { type Logger } from "pino";

// Patterns redacted from any log entry. Keep this list in sync with
// docs/07_SECURITY.md and packages/core/src/crypto.
const REDACT_PATHS = [
  "*.password",
  "*.passwordHash",
  "*.privateKey",
  "*.private_key",
  "*.privateKeyPem",
  "*.serviceAccountJson",
  "*.secretRef",
  "*.material",
  "*.material.content",
  "credential.material",
  "credential.material.content",
  "headers.authorization",
  "headers.cookie",
  "headers['x-csrf-token']",
];

function build(): Logger {
  const isDev = process.env.NODE_ENV !== "production";
  return pino({
    level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    base: { app: "gp-web", env: process.env.NODE_ENV ?? "development" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    transport: isDev
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", singleLine: false },
        }
      : undefined,
  });
}

const globalKey = "__gp_logger__" as const;
const g = globalThis as unknown as Record<string, Logger | undefined>;
if (!g[globalKey]) g[globalKey] = build();

export const logger: Logger = g[globalKey];
