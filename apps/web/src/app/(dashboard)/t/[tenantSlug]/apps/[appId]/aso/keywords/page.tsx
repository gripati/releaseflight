/**
 * Legacy /aso/keywords — promoted to /keywords (top-level tab) in the
 * new IA.
 */
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export default async function AsoKeywordsRedirect({
  params,
}: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  redirect(`/t/${tenantSlug}/apps/${appId}/keywords`);
}
