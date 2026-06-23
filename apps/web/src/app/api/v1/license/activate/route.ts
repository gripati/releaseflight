import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activateLicense } from "@marquee/license";
import { requireRole, requireTenant } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { withApiErrors } from "@/lib/responses";

/**
 * Activate this installation against the owner's license server. Owner-only
 * system action: it binds the install to a hardware fingerprint and caches the
 * signed token locally. The activation outcome (incl. SEAT_TAKEN / INVALID_KEY)
 * is returned verbatim so the UI can show a precise, actionable message.
 */
const Body = z.object({
  licenseKey: z.string().min(4).max(128),
  email: z.string().email().max(320),
  deviceLabel: z.string().max(120).optional(),
});

export const POST = withApiErrors(async (req: NextRequest) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "OWNER");

  const body = Body.parse(await req.json());
  const result = await activateLicense({
    licenseKey: body.licenseKey,
    email: body.email,
    deviceLabel: body.deviceLabel,
  });
  return NextResponse.json(result);
});
