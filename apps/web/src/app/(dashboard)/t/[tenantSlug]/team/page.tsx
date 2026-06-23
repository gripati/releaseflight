import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string }>;
}

/**
 * "Team" was merged into "Seats" — a single page now manages both members and
 * seats. This route is kept only as a redirect so existing links / bookmarks
 * (and the old `g`-nav muscle memory) don't 404.
 */
export default async function TeamPage({ params }: PageProps): Promise<never> {
  const { tenantSlug } = await params;
  redirect(`/t/${tenantSlug}/seats`);
}
