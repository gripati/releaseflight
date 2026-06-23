import { NextResponse, type NextRequest } from "next/server";
import { FirebaseAppDistribution, FirebaseClient, GoogleAuth, NotFoundError } from "@marquee/core";
import { prisma } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Tester groups rarely change but the Firebase listGroups call is slow (~3s).
// Cache the result per Firebase app id for a couple of minutes so revisits and
// the deploy-tab's active-build poll don't re-hit Firebase (and don't starve
// the sibling requests the page fires in parallel). `selected` stays fresh.
type CachedGroups = { alias: string; displayName: string; testerCount: number | null }[];
const GROUPS_CACHE = new Map<string, { at: number; groups: CachedGroups }>();
const GROUPS_TTL_MS = 120_000;

/**
 * Lists the Firebase project's tester groups for the deploy launcher's
 * "release to this group" picker (mirrors the Unity GamePublisher flow). The
 * connection's saved tester groups are returned as `selected` so the picker
 * pre-checks the user's usual targets. Read-only → no CSRF.
 */
export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id: appId } = await context.params;
  const sp = createSecretProvider();

  return withTenantContext(async () => {
    const conn = await prisma.appConnection.findFirst({
      where: { appId, kind: "FIREBASE", tenantId: ctx.tenant!.id },
    });
    if (!conn) throw new NotFoundError("No Firebase connection for this app.");

    const app = await prisma.app.findFirst({ where: { id: appId } });
    const meta = (conn.metadata as Record<string, unknown> | null) ?? {};
    const selected = Array.isArray(meta.testerGroups) ? (meta.testerGroups as string[]) : [];
    // Prefer the app's own platform's id; fall back to the other if absent.
    const iosId = meta.iosAppId as string | undefined;
    const androidId = meta.androidAppId as string | undefined;
    const fbAppId = app?.platform === "ANDROID" ? (androidId ?? iosId) : (iosId ?? androidId);
    if (!fbAppId) {
      return NextResponse.json({
        groups: [],
        selected,
        note: "Add a Firebase app id to the connection to list tester groups.",
      });
    }

    // Namespace the in-process cache by tenant: two tenants that reference the
    // same Firebase app id must NOT share a cached group list fetched with the
    // other's credentials (RLS doesn't govern an in-memory Map).
    const cacheKey = `${ctx.tenant!.id}:${fbAppId}`;
    const cached = GROUPS_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < GROUPS_TTL_MS) {
      return NextResponse.json({ groups: cached.groups, selected });
    }

    const secret = await sp.get(conn.secretRef);
    let parsed: { client_email?: string; private_key?: string; project_id?: string };
    try {
      parsed = JSON.parse(secret.content) as typeof parsed;
    } catch {
      return NextResponse.json({
        groups: [],
        selected,
        note: "Firebase credentials could not be read — reconnect the Firebase service account.",
      });
    }
    const client = new FirebaseClient(new GoogleAuth(), {
      id: "firebase-groups",
      clientEmail: parsed.client_email ?? "",
      privateKeyPem: parsed.private_key ?? "",
      projectId: parsed.project_id,
    });
    const fad = new FirebaseAppDistribution(client);
    const groups = await fad.listGroups(fbAppId);
    const mapped: CachedGroups = groups.map((g) => ({
      alias: g.alias,
      displayName: g.displayName,
      testerCount: g.testerCount ?? null,
    }));
    GROUPS_CACHE.set(cacheKey, { at: Date.now(), groups: mapped });

    return NextResponse.json({ groups: mapped, selected });
  });
});
