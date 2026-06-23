/**
 * Legacy /aso/daily — folded into /pulse under the new IA.
 */
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<{ date?: string }>;
}

export default async function AsoDailyRedirect({
  params,
  searchParams,
}: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const qs = sp.date ? `?date=${encodeURIComponent(sp.date)}` : "";
  redirect(`/t/${tenantSlug}/apps/${appId}/pulse${qs}`);
}
