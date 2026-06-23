import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { BuildsPanel } from "@/components/builds/BuildsPanel";
import { SubmissionPanel } from "@/components/builds/SubmissionPanel";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

/**
 * "Release" — pick a build and ship a version.
 *
 * iOS: the App Store Connect builds + the submit-for-review workflow (one panel
 * lists the builds, you select a VALID one and submit) — mirrors the Unity
 * GamePublisher flow. Android: the Play bundles + track promotion (beta →
 * production); there's no separate "submit for review" step on Play.
 */
export default async function ReleasePage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const data = await tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () => {
      const app = await prisma.app.findUnique({ where: { id: appId } });
      if (!app) return null;
      if (app.platform !== "IOS") return { app, locales: 0, screenshots: 0 };
      const [locales, screenshots] = await Promise.all([
        prisma.appLocalization.count({ where: { appId } }),
        prisma.screenshot.count({ where: { appId } }),
      ]);
      return { app, locales, screenshots };
    },
  );
  if (!data) notFound();
  const { app } = data;

  if (app.platform === "IOS") {
    return (
      <SubmissionPanel
        appId={app.id}
        versionId={app.versionId}
        versionString={app.versionString}
        status={app.status}
        localeCount={data.locales}
        screenshotCount={data.screenshots}
        discoveredScreenshotTypes={app.discoveredScreenshotTypes}
      />
    );
  }

  return (
    <BuildsPanel
      appId={app.id}
      platform={app.platform}
      bundleId={app.bundleId}
      versionString={app.versionString}
      versionId={app.versionId}
    />
  );
}
