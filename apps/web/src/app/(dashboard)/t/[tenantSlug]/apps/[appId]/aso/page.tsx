/**
 * Legacy /aso index — folded into the new IA. The catch-all is /pulse
 * since the operator usually lands here looking for "what changed
 * today".
 */
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export default async function AsoRedirect({ params }: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  redirect(`/t/${tenantSlug}/apps/${appId}/pulse`);
}
