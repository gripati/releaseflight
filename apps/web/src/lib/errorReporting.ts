/**
 * Optional external error reporting (Sentry or compatible).
 *
 * - When SENTRY_DSN is set, server-side errors logged via `logger.error`
 *   are also forwarded to the configured DSN.
 * - When unset, this module is a no-op — there is NO required external
 *   dependency. The self-host story stays "drop the binary, run".
 *
 * To wire it up in production:
 *   1. `pnpm add @sentry/node` (lazy-loaded below so the dep is optional)
 *   2. Set SENTRY_DSN, SENTRY_ENV, SENTRY_RELEASE in your env
 *   3. Restart the web + worker containers
 */

interface ErrorContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  route?: string;
  [k: string]: unknown;
}

interface ErrorReporter {
  capture: (err: unknown, context?: ErrorContext) => void;
  flush: () => Promise<void>;
}

// Keys whose VALUES must never leave the trust boundary. Mirrors the pino
// redact list in logger.ts — Sentry events bypass pino, so they need their
// own scrub or Apple .p8 keys / Google service-account JSON / session
// secrets could be shipped in plaintext to a third-party SaaS.
const SENSITIVE_KEY =
  /(pass(word|hash)?|secret|privatekey|private_key|serviceaccount|service_account|p8|pem|token|authorization|cookie|api[-_]?key|material|credential)/i;

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[Truncated]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : scrubValue(v, depth + 1);
  }
  return out;
}

/**
 * Sentry `beforeSend` hook: deep-scrub the carrier fields most likely to hold
 * secrets (extra/contexts populated from error properties, request data and
 * headers) before the event is transmitted.
 */
function scrubEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (event.extra) event.extra = scrubValue(event.extra);
  if (event.contexts) event.contexts = scrubValue(event.contexts);
  const req = event.request as Record<string, unknown> | undefined;
  if (req) {
    if (req.data) req.data = scrubValue(req.data);
    if (req.headers) req.headers = scrubValue(req.headers);
    if (req.cookies) req.cookies = "[REDACTED]";
  }
  return event;
}

let reporter: ErrorReporter = {
  capture: () => {
    /* no-op until init() lazily binds Sentry */
  },
  flush: async () => {
    /* no-op */
  },
};

let initialised = false;

export async function initErrorReporting(): Promise<void> {
  if (initialised) return;
  initialised = true;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return; // Stay no-op

  try {
    // Hide the import specifier from the bundler so webpack/Turbopack
    // don't try to resolve @sentry/node at build time. The package is
    // only loaded at runtime when SENTRY_DSN is non-empty.
    interface SentryNamespace {
      init: (opts: Record<string, unknown>) => void;
      captureException: (err: unknown, opts?: { extra?: Record<string, unknown> }) => void;
      flush: (ms?: number) => Promise<boolean>;
    }
    const specifier = ["@sentry", "node"].join("/");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
    const mod = (await dynamicImport(specifier).catch(() => null)) as
      | { default?: SentryNamespace }
      | SentryNamespace
      | null;
    if (!mod) return; // Package isn't installed — stay no-op
    const Sentry =
      "default" in (mod as Record<string, unknown>)
        ? (mod as { default: SentryNamespace }).default
        : (mod as SentryNamespace);

    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "development",
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: 0.1,
      profilesSampleRate: 0.1,
      // Last line of defence: scrub secrets from every event before it is
      // transmitted to the external DSN.
      beforeSend: (event: Record<string, unknown>) => scrubEvent(event),
    });
    reporter = {
      capture: (err, context) =>
        Sentry.captureException(
          err,
          context ? { extra: scrubValue(context) as Record<string, unknown> } : undefined,
        ),
      flush: async () => {
        await Sentry.flush(2000);
      },
    };
  } catch {
    /* On failure, fall back to no-op silently */
  }
}

export function captureError(err: unknown, context?: ErrorContext): void {
  reporter.capture(err, context);
}

export async function flushErrorReporting(): Promise<void> {
  await reporter.flush();
}
