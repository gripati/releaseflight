/**
 * Legacy /aso/history — moved under /keywords/history in the new IA.
 */
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<{ range?: string }>;
}

export default async function AsoHistoryRedirect({
  params,
  searchParams,
}: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const qs = sp.range ? `?range=${encodeURIComponent(sp.range)}` : "";
  redirect(`/t/${tenantSlug}/apps/${appId}/keywords/history${qs}`);
}
