import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, NotFoundError } from "@marquee/core";
import { createStorage, FilesystemStorage, parseStorageKey } from "@marquee/storage";
import { prismaUnscoped } from "@marquee/db";
import { getSessionFromCookie } from "@/lib/session";
import { assertAppAccess } from "@/lib/auth-helpers";

interface RouteContext {
  params: Promise<{ key: string[] }>;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const provider = createStorage();

export async function GET(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { key: keyParts } = await context.params;
  const key = keyParts.map((p) => decodeURIComponent(p)).join("/");

  // Mode 1: signed URL — checked by the FilesystemStorage signer if present
  const url = new URL(req.url);
  const exp = url.searchParams.get("exp");
  const nonce = url.searchParams.get("n");
  const sig = url.searchParams.get("s");

  let authorised = false;
  if (exp && nonce && sig && provider instanceof FilesystemStorage) {
    authorised = provider.verifySignedUrl(key, exp, nonce, sig);
  }

  // Mode 2: session-based — verify the session user is a member of the
  // tenant that owns this key
  if (!authorised) {
    const session = await getSessionFromCookie();
    if (!session) throw new ForbiddenError("Authentication required");
    const { tenantId, rest } = parseStorageKey(key);
    if (!tenantId) throw new ForbiddenError("Unscoped storage key");
    const m = await prismaUnscoped.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId: session.userId } },
    });
    if (!m) throw new ForbiddenError("Not a member of this workspace");
    // Enforce per-member app scoping for app-owned assets (keys shaped
    // `tenants/<tid>/apps/<appId>/…`). This path bypasses RLS (prismaUnscoped +
    // filesystem store), so the allowedAppIds check must be explicit — otherwise
    // a member scoped to App A could read App B's screenshots/previews by key.
    if (rest[0] === "apps" && rest[1]) {
      assertAppAccess(m.allowedAppIds, rest[1]);
    }
  }

  try {
    const obj = await provider.get(key);
    return new NextResponse(obj.body as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": obj.contentType ?? "application/octet-stream",
        "content-length": obj.size.toString(),
        "cache-control": "private, max-age=300",
      },
    });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new NotFoundError("Asset not found");
    throw err;
  }
}
