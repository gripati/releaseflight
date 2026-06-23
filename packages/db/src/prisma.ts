import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { tenantStorage } from "./tenantContext";

/**
 * Tenant-aware Prisma client.
 *
 * Every query is wrapped in a transaction that sets the per-connection
 * `app.current_tenant` GUC from the AsyncLocalStorage context. Row-Level
 * Security policies on Postgres then enforce isolation.
 *
 * If the request runs without a tenant context the GUC is NULL and RLS
 * policies evaluate to FALSE, so no rows are returned. This is the
 * desired fail-closed behaviour.
 */
// Two globalThis-pinned singletons so the client survives module duplication in
// the production bundle (Next splits @marquee/db across chunks):
//   • __gp_prisma__      — the EXTENDED client (tenant-context GUC wrapper). This
//                          is what `prisma` exports and every request uses.
//   • __gp_prisma_base__ — the UNEXTENDED base client, for tenantTransaction.
// CRITICAL: a re-evaluation of this module MUST return the EXTENDED client. The
// previous code stored the base client in __gp_prisma__ and returned `extended`
// only on first eval — so a duplicated module instance got the BASE client (no
// extension ⇒ no RLS GUC ⇒ zero rows). Store + return the EXTENDED client.
const PRISMA_KEY = "__gp_prisma__" as const;
const PRISMA_BASE_KEY = "__gp_prisma_base__" as const;
type PrismaGlobals = Record<typeof PRISMA_KEY | typeof PRISMA_BASE_KEY, PrismaClient | undefined>;

function createPrisma(): PrismaClient {
  const g = globalThis as unknown as PrismaGlobals;
  if (g[PRISMA_KEY]) return g[PRISMA_KEY];

  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  // Use Prisma client extensions to wrap each operation in a tenant-scoped tx.
  // We avoid the legacy $use middleware because it is incompatible with
  // connection pools that don't preserve session GUCs across queries.
  const extended = client.$extends({
    name: "tenantContext",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const ctx = tenantStorage.getStore();

          // Allow explicit bypass for migrations, cron, /admin routes.
          if (!ctx || ctx.bypassRls) {
            return query(args);
          }

          // Bind the tenant GUC and the actual query to the SAME connection
          // by batching them in one $transaction([...]). In the ARRAY form,
          // Prisma runs every PrismaPromise inside a single transaction over a
          // single pooled connection, sequentially — so the transaction-local
          // `app.current_tenant` set by the first statement is in effect when
          // RLS evaluates `query(args)` as the second.
          //
          // NOTE: per-op array batching is how THIS extension binds the GUC to a
          // single op. It does NOT make a user-level `prisma.$transaction([a, b])`
          // atomic — each op re-enters here and gets its OWN array transaction, so
          // a, b run in separate transactions. For an ATOMIC multi-statement,
          // tenant-scoped batch use `tenantTransaction()` below (one interactive
          // transaction on the unextended base client; verified by the RLS suite).
          // `query(args)` is the chain's "next", so this does not recurse.
          // Publish BOTH the tenant id and the per-member app scope on the
          // SAME connection so RLS sees them when it evaluates query(args).
          // An empty allowed_app_ids GUC means "unrestricted" (allowed_app_ids()
          // resolves to NULL in SQL), so this is backward-compatible for any
          // context that doesn't set allowedAppIds.
          const allowedAppIds = (ctx.allowedAppIds ?? []).join(",");
          const [, , result] = await client.$transaction([
            client.$executeRawUnsafe(
              `SELECT set_config('app.current_tenant', $1, true)`,
              ctx.tenantId,
            ),
            client.$executeRawUnsafe(
              `SELECT set_config('app.allowed_app_ids', $1, true)`,
              allowedAppIds,
            ),
            query(args),
          ]);
          return result;
        },
      },
    },
  });

  g[PRISMA_BASE_KEY] = client; // base — used only by tenantTransaction
  g[PRISMA_KEY] = extended as unknown as PrismaClient; // extended — the default singleton
  return g[PRISMA_KEY];
}

export const prisma: PrismaClient = createPrisma();

/**
 * Atomic, tenant-scoped multi-statement transaction.
 *
 * The per-operation `tenantContext` extension wraps EVERY model op in its own
 * `client.$transaction([...])`, which means a user-level `prisma.$transaction([opA, opB])`
 * runs each op in a SEPARATE transaction — non-atomic (a mid-batch failure leaves
 * earlier writes committed). This helper instead opens ONE interactive
 * transaction on the UNEXTENDED base client (so the ops inside are NOT
 * re-wrapped) and sets the `app.current_tenant` / `app.allowed_app_ids` GUCs
 * (LOCAL = transaction-scoped) on that same connection before running the
 * callback. RLS is enforced and the whole batch commits or rolls back together.
 *
 * Use this for any multi-write that must be atomic. The callback's `tx` ops run
 * sequentially on the transaction connection — do NOT Promise.all them.
 */
export async function tenantTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const g = globalThis as unknown as PrismaGlobals;
  const base = g[PRISMA_BASE_KEY];
  if (!base) throw new Error("tenantTransaction: base Prisma client not initialised");
  const ctx = tenantStorage.getStore();
  return base.$transaction(async (tx) => {
    if (ctx && !ctx.bypassRls) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, ctx.tenantId);
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.allowed_app_ids', $1, true)`,
        (ctx.allowedAppIds ?? []).join(","),
      );
    }
    return fn(tx);
  });
}

/**
 * Bypass-RLS Prisma client. ONLY used for:
 *   - Database migrations
 *   - Seed scripts
 *   - Platform admin endpoints (/admin/*) after explicit auth check
 *   - Cross-tenant maintenance jobs (cleanup, billing reconciliation)
 *
 * Requires DATABASE_URL_ADMIN env or falls back to the regular pooled client
 * but signals intent via bypassRls=true on tenantStorage.
 */
function createUnscoped(): PrismaClient {
  const globalKey = "__gp_prisma_admin__" as const;
  const g = globalThis as unknown as Record<typeof globalKey, PrismaClient | undefined>;
  if (g[globalKey]) return g[globalKey];

  // Only pass `datasources` when DATABASE_URL_ADMIN is an explicit
  // override — otherwise let Prisma read DATABASE_URL from the
  // environment itself (the same path the scoped client uses).
  // Passing `{ url: undefined }` triggers a constructor validation
  // error in @prisma/client ≥5, which used to be silently tolerated.
  const adminUrl = process.env.DATABASE_URL_ADMIN;
  const client = new PrismaClient({
    ...(adminUrl ? { datasources: { db: { url: adminUrl } } } : {}),
    log: ["error"],
  });

  g[globalKey] = client;
  return client;
}

export const prismaUnscoped: PrismaClient = createUnscoped();

/**
 * Run a callback with bypass-RLS context. Intended for short maintenance
 * tasks; long-lived admin sessions should use their own connection pool.
 */
export async function runUnscoped<T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> {
  return fn(prismaUnscoped);
}

/**
 * Boot-time safety check: verify the role the application connects as is
 * actually subject to Row-Level Security. Postgres SUPERUSER and BYPASSRLS
 * roles ignore every tenant_isolation policy, so connecting as one silently
 * disables tenant isolation — the single most important control in this
 * product. Call this once at process startup (web instrumentation + worker).
 *
 * In production this THROWS (fail-secure) unless explicitly overridden with
 * MARQUEE_ALLOW_INSECURE_DB_ROLE=1. Outside production it warns loudly.
 */
export async function assertDbRoleRespectsRls(): Promise<void> {
  interface Row {
    role: string;
    is_superuser: boolean;
    bypassrls: boolean;
  }
  const probe = async (client: PrismaClient): Promise<Row | undefined> => {
    try {
      const rows = await client.$queryRawUnsafe<Row[]>(
        `SELECT rolname AS role, rolsuper AS is_superuser, rolbypassrls AS bypassrls
           FROM pg_roles WHERE rolname = current_user`,
      );
      return rows[0];
    } catch {
      // Can't determine the role (permissions / non-Postgres) — don't block.
      return undefined;
    }
  };

  // (1) The SCOPED client (DATABASE_URL) MUST be subject to RLS. A superuser
  //     or BYPASSRLS role silently disables every tenant_isolation policy.
  const scoped = await probe(prisma);
  if (scoped && (scoped.is_superuser || scoped.bypassrls)) {
    const why = scoped.is_superuser ? "a SUPERUSER" : "a BYPASSRLS role";
    const msg =
      `[SECURITY] App DB role '${scoped.role}' is ${why}; it bypasses Row-Level Security, ` +
      `so tenant isolation is NOT enforced. Connect the app as a NOSUPERUSER NOBYPASSRLS ` +
      `role (see 'gp_app' in packages/db/prisma/rls.sql) via DATABASE_URL.`;
    if (
      process.env.NODE_ENV === "production" &&
      process.env.MARQUEE_ALLOW_INSECURE_DB_ROLE !== "1"
    ) {
      throw new Error(
        `${msg} Refusing to start. (Set MARQUEE_ALLOW_INSECURE_DB_ROLE=1 to override — NOT recommended.)`,
      );
    }

    console.warn(`${msg} Continuing because NODE_ENV!=production — fix before production.`);
  }

  // (2) The UNSCOPED/admin client (DATABASE_URL_ADMIN) is used for auth
  //     bootstrap (membership lookup) and cross-tenant maintenance on
  //     RLS-protected tables (e.g. invitation accept). It therefore SHOULD
  //     bypass RLS. If the scoped role is correctly RLS-bound but the admin
  //     client is the SAME non-bypass role (DATABASE_URL_ADMIN unset), those
  //     paths will silently return zero rows. Warn loudly so the operator
  //     sets DATABASE_URL_ADMIN to a BYPASSRLS role (gp / gp_migration_admin).
  if (scoped && !scoped.is_superuser && !scoped.bypassrls) {
    const admin = await probe(prismaUnscoped);
    if (admin && !admin.is_superuser && !admin.bypassrls) {
      console.warn(
        `[SECURITY] The unscoped/admin DB role '${admin.role}' does NOT bypass RLS. ` +
          `Auth bootstrap and cross-tenant maintenance (e.g. invitation accept) will fail. ` +
          `Set DATABASE_URL_ADMIN to a BYPASSRLS role (gp / gp_migration_admin).`,
      );
    }
  }

  // (3) The role bits above are necessary but not sufficient: a correctly
  //     NOSUPERUSER NOBYPASSRLS role still has ZERO tenant isolation if the RLS
  //     policy step (pnpm db:rls / prisma/rls.sql) was never applied — e.g. a
  //     schema-only `prisma db push`. Assert the policies are actually in force.
  await assertTenantTablesForceRls();
}

/**
 * The tenant-scoped tables that prisma/rls.sql applies `FORCE ROW LEVEL
 * SECURITY` to. Kept in sync with that file; a table here but unprotected in
 * the database means the RLS step did not run.
 */
const TENANT_SCOPED_TABLES = [
  "Credential",
  "App",
  "AppLocalization",
  "Screenshot",
  "AppPreview",
  "AndroidImage",
  "Job",
  "AuditEvent",
  "TenantSetting",
  "UsageRecord",
  "Subscription",
  "AnalyticsSnapshot",
  "AnalyticsFunnel",
  "TrackedKeyword",
  "KeywordSignal",
  "AiUsage",
  "AiKeywordSuggestion",
  "LearnedNoiseTerm",
  "AiRelevanceCache",
  "Competitor",
  "CompetitorRank",
  "CompetitorSnapshot",
  "MetadataSnapshot",
  "AsoDailyCheck",
  "AsoAlarm",
  "AsoNotification",
  "AppConnection",
  "AppBuildConfig",
  "Build",
];

/**
 * Boot-time safety check: verify that tenant-scoped tables which exist in the
 * database actually have ROW LEVEL SECURITY enabled AND forced. This catches
 * the "schema deployed but rls.sql never applied" footgun (no Prisma migration
 * carries the policies), which would leave every tenant table globally readable.
 *
 * In production this THROWS unless overridden with MARQUEE_ALLOW_INSECURE_DB_ROLE=1.
 * Outside production it warns. Tables absent from the DB (not yet migrated) are
 * ignored; introspection failures never block startup.
 */
export async function assertTenantTablesForceRls(): Promise<void> {
  interface Row {
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }
  let rows: Row[];
  try {
    rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
      TENANT_SCOPED_TABLES,
    );
  } catch {
    // Can't introspect (permissions / non-Postgres) — don't block.
    return;
  }

  const byName = new Map(rows.map((r) => [r.relname, r]));
  const unprotected = TENANT_SCOPED_TABLES.filter((t) => {
    const r = byName.get(t);
    // Only flag tables that EXIST but lack forced RLS. A not-yet-migrated table
    // is out of scope for this check.
    return r && !(r.relrowsecurity && r.relforcerowsecurity);
  });

  if (unprotected.length > 0) {
    const msg =
      `[SECURITY] Row-Level Security is NOT forced on tenant table(s): ${unprotected.join(", ")}. ` +
      `The RLS policy step (pnpm db:rls / packages/db/prisma/rls.sql) has not been applied to this ` +
      `database, so tenant isolation is DISABLED for these tables.`;
    if (
      process.env.NODE_ENV === "production" &&
      process.env.MARQUEE_ALLOW_INSECURE_DB_ROLE !== "1"
    ) {
      throw new Error(`${msg} Refusing to start. Run \`pnpm db:rls\` against this database.`);
    }

    console.warn(`${msg} Continuing because NODE_ENV!=production — fix before production.`);
  }
}
