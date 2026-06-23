/**
 * Legacy /studio route — renamed to /metadata. Existing links and
 * bookmarks keep working through this redirect stub.
 */
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export default async function StudioRedirect({ params }: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  redirect(`/t/${tenantSlug}/apps/${appId}/metadata`);
}
