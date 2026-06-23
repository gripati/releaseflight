/**
 * Next.js instrumentation — runs once per server process at startup.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * We use it for two startup concerns that must happen before any request is
 * served:
 *   1. Initialise optional error reporting (Sentry) — was previously never
 *      wired up, so captureError() was a silent no-op.
 *   2. Fail-secure tenant-isolation guard: in production, refuse to boot if
 *      the database role bypasses Row-Level Security.
 */
export async function register(): Promise<void> {
  // Only the Node.js server runtime talks to Postgres / loads server deps.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { initErrorReporting } = await import("@/lib/errorReporting");
  await initErrorReporting();

  const { assertDbRoleRespectsRls } = await import("@marquee/db");
  // Throws in production if the connected role is SUPERUSER/BYPASSRLS, which
  // would silently disable every tenant_isolation policy.
  await assertDbRoleRespectsRls();
}
