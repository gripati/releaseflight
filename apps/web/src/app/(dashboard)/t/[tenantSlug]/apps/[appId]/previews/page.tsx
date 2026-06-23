import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { PreviewsPanel } from "@/components/previews/PreviewsPanel";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export default async function PreviewsPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const data = await tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () => {
      const app = await prisma.app.findUnique({ where: { id: appId } });
      if (!app) return null;
      const previews = await prisma.appPreview.findMany({
        where: { appId },
        orderBy: [{ locale: "asc" }, { ordinal: "asc" }],
      });
      return { app, previews };
    },
  );
  if (!data) notFound();

  if (data.app.platform !== "IOS") {
    return (
      <div className="page-loaded mx-auto max-w-md py-16 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-tertiary)]">
          NOT APPLICABLE
        </p>
        <h2
          className="mt-4 font-display text-3xl"
          style={{ fontVariationSettings: "'wght' 600" }}
        >
          Previews are iOS-only
        </h2>
        <p className="mt-3 font-body text-[13px] text-[var(--ink-secondary)]">
          Google Play does not support per-listing video previews. Use the{" "}
          <em>video URL</em> field in the Metadata editor for a YouTube link instead.
        </p>
      </div>
    );
  }

  return (
    <PreviewsPanel
      appId={data.app.id}
      primaryLocale={data.app.primaryLocale}
      availableLanguages={data.app.availableLanguages}
      discoveredTypes={data.app.discoveredPreviewTypes}
      initialPreviews={data.previews.map((p) => ({
        id: p.id,
        locale: p.locale,
        previewType: p.applePreviewType,
        fileName: p.fileName,
        ordinal: p.ordinal,
        state: p.state,
        storageKey: p.storageKey,
        thumbnailKey: p.thumbnailKey,
        upstreamVideoUrl: p.upstreamVideoUrl,
        upstreamPosterUrl: p.upstreamPosterUrl,
        mimeType: p.mimeType,
        fileSize: p.fileSize,
      }))}
    />
  );
}
