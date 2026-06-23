import { NextResponse } from "next/server";
import { AuthRequiredError } from "@marquee/core";
import { getEntitlements, getLicenseStatus, licenseConfig } from "@marquee/license";
import { withApiErrors } from "@/lib/responses";
import { getSessionFromCookie } from "@/lib/session";

/**
 * Sealed-distribution license status, for the in-app nag banner. Read-only,
 * authenticated. Returns `{ enforced: false }` when licensing is off (dev /
 * non-sealed self-host), so the banner stays hidden and nothing changes for
 * existing deployments.
 */
export const dynamic = "force-dynamic";

export const GET = withApiErrors(async () => {
  const session = await getSessionFromCookie();
  if (!session) throw new AuthRequiredError();

  if (!licenseConfig.enforcement) {
    return NextResponse.json({ enforced: false, status: null, billing: null });
  }
  const status = getLicenseStatus();
  // Billing/seat entitlements come straight from the verified token (no DB hit),
  // so the banner can surface past_due / grace / suspended / seats_exceeded and
  // the "Manage billing" link.
  return NextResponse.json({ enforced: true, status, billing: getEntitlements() });
});
