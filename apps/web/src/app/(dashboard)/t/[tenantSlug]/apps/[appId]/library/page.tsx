import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

/**
 * "Library" was a card hub; its sections are now first-class tabs
 * (Screenshots · Previews · Release · History). Redirect old links to the first.
 */
export default async function LibraryPage({ params }: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  redirect(`/t/${tenantSlug}/apps/${appId}/screenshots`);
}
