/**
 * Legacy /aso/keywords/[kwId] — moved under /keywords/[kwId] in the
 * new IA. Forwards any range filter so deep-linked charts keep their
 * window.
 */
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string; kwId: string }>;
  searchParams: Promise<{ range?: string }>;
}

export default async function AsoKeywordDetailRedirect({
  params,
  searchParams,
}: PageProps): Promise<never> {
  const { tenantSlug, appId, kwId } = await params;
  const sp = await searchParams;
  const qs = sp.range ? `?range=${encodeURIComponent(sp.range)}` : "";
  redirect(`/t/${tenantSlug}/apps/${appId}/keywords/${kwId}${qs}`);
}
