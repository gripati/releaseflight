import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

/**
 * Submission merged into the "Release" tab (binary builds + submit-for-review
 * are two halves of shipping a version). Redirect old links there.
 */
export default async function SubmissionPage({ params }: PageProps): Promise<never> {
  const { tenantSlug, appId } = await params;
  redirect(`/t/${tenantSlug}/apps/${appId}/builds`);
}
