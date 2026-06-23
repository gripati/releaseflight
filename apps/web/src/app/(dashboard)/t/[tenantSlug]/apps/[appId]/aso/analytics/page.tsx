/**
 * Legacy /aso/analytics — promoted to a top-level /analytics tab under
 * the new IA.
 */
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<{ range?: string; territory?: string }>;
}

export default async function AsoAnalyticsRedirect({
  params,
  searchParams,
}: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (sp.range) qs.set("range", sp.range);
  if (sp.territory) qs.set("territory", sp.territory);
  const suffix = qs.toString();
  redirect(
    `/t/${tenantSlug}/apps/${appId}/analytics${suffix ? `?${suffix}` : ""}`,
  );
}
