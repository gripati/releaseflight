import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { ScreenshotsPanel } from "@/components/screenshots/ScreenshotsPanel";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export default async function ScreenshotsPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const data = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
    },
    async () => {
      const app = await prisma.app.findUnique({ where: { id: appId } });
      if (!app) return null;
      const screenshots = await prisma.screenshot.findMany({
        where: { appId },
        orderBy: [{ locale: "asc" }, { ordinal: "asc" }],
      });
      return { app, screenshots };
    },
  );
  if (!data) notFound();

  return (
    <ScreenshotsPanel
      appId={data.app.id}
      platform={data.app.platform}
      primaryLocale={data.app.primaryLocale}
      availableLanguages={data.app.availableLanguages}
      discoveredTypes={data.app.discoveredScreenshotTypes}
      initialScreenshots={data.screenshots.map((s) => ({
        id: s.id,
        locale: s.locale,
        displayType: s.appleDisplayType ?? s.googleImageType ?? "",
        fileName: s.fileName,
        width: s.width,
        height: s.height,
        ordinal: s.ordinal,
        state: s.state,
        thumbnailKey: s.thumbnailKey,
        storageKey: s.storageKey,
        upstreamUrl: s.upstreamUrl,
        fileSize: s.fileSize,
      }))}
    />
  );
}
