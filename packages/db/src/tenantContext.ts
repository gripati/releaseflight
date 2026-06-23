import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantRole } from "@prisma/client";

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: TenantRole;
  requestId: string;
  /**
   * Per-member app scope. When non-empty, the Prisma extension publishes it as
   * the `app.allowed_app_ids` GUC and RLS restricts App + app-owned child rows
   * to this set. Empty/undefined = unrestricted (every app in the tenant).
   */
  allowedAppIds?: string[];
  /**
   * True when this context belongs to a platform-admin operation that
   * intentionally bypasses tenant scoping (e.g. /admin/* routes, cron).
   * MUST only be set from server-side code with admin role check.
   */
  bypassRls?: boolean;
}

/**
 * Pinned to globalThis so it is a TRUE singleton across every bundle chunk.
 *
 * Next.js can bundle `@marquee/db` into multiple server chunks (the RSC page
 * bundle, each route-handler bundle, etc.). A plain module-level
 * `new AsyncLocalStorage()` would then be instantiated once PER chunk — so a
 * page's `tenantStorage.run(ctx, …)` (chunk A) and the Prisma extension's
 * `tenantStorage.getStore()` (chunk B, where the client singleton lives) would
 * use DIFFERENT stores. The extension would then see no context, set no GUC,
 * and RLS would fail-closed to ZERO rows in production (works in dev, where the
 * module graph isn't split). Pinning to globalThis guarantees one shared
 * instance — the same technique `prisma.ts` uses for the client.
 */
const TENANT_ALS_KEY = "__gp_tenant_storage__" as const;
const alsGlobal = globalThis as unknown as Record<
  typeof TENANT_ALS_KEY,
  AsyncLocalStorage<TenantContext> | undefined
>;
export const tenantStorage: AsyncLocalStorage<TenantContext> =
  alsGlobal[TENANT_ALS_KEY] ?? (alsGlobal[TENANT_ALS_KEY] = new AsyncLocalStorage<TenantContext>());

export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

export function requireTenantContext(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx) {
    throw new Error(
      "Tenant context missing. Wrap the request in withTenantContext or call inside tenantStorage.run.",
    );
  }
  return ctx;
}

export function getCurrentTenantId(): string {
  return requireTenantContext().tenantId;
}
