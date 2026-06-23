/**
 * Legacy /aso/competitors — moved under /keywords/competitors in the
 * new IA so competitor research lives alongside the other keyword
 * decisions.
 */
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export default async function AsoCompetitorsRedirect({
  params,
}: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  redirect(`/t/${tenantSlug}/apps/${appId}/keywords/competitors`);
}
