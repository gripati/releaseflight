/**
 * Legacy /overview route — folded into /pulse under the new IA. Keeps
 * bookmarks and outbound links working by bouncing to the new home.
 *
 * Forwards `?sync=…` and any other query so the AppSyncIndicator that
 * fires after a sync click still lights up on the Pulse landing.
 */
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function OverviewRedirect({
  params,
  searchParams,
}: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v != null) qs.set(k, v);
  const suffix = qs.toString();
  redirect(
    `/t/${tenantSlug}/apps/${appId}/pulse${suffix ? `?${suffix}` : ""}`,
  );
}
