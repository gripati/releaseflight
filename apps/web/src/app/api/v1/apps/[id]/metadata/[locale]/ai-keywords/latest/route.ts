/**
 * GET /api/v1/apps/[id]/metadata/[locale]/ai-keywords/latest
 *
 * Re-hydrate the per-locale AI keyword recommendations panel after a
 * refresh. The POST sibling stores its full response in the
 * `AiKeywordSuggestion` row keyed by (appId, locale); this endpoint
 * just reads it back. The user sees the same suggestions until they
 * click Regenerate, which overwrites the row.
 *
 * Response shape (200):
 *   • `{ data: null }` — never generated for this locale
 *   • `{ data: <KeywordRecommendationsResponse>, generatedAt: ISO }`
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string; locale: string }>;
}

export const dynamic = "force-dynamic";

interface LatestResponse {
  data: unknown | null;
  generatedAt: string | null;
}

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id, locale } = await context.params;

  return withTenantContext(async () => {
    // Confirm app belongs to the tenant. RLS would also reject the
    // suggestion query but a missing-app 404 is friendlier than a
    // silent "data: null".
    const app = await prisma.app.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!app) throw new NotFoundError("App not found");

    const row = await prisma.aiKeywordSuggestion.findUnique({
      where: { appId_locale: { appId: id, locale } },
      select: { payload: true, updatedAt: true },
    });

    const response: LatestResponse = row
      ? {
          data: row.payload,
          generatedAt: row.updatedAt.toISOString(),
        }
      : { data: null, generatedAt: null };

    return NextResponse.json<LatestResponse>(response);
  });
});
