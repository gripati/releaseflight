/**
 * Metadata — copy-editing workspace.
 *
 * Owns title / subtitle / description / promotional text / what's new /
 * URLs for every locale. Keywords field has its own dedicated tab
 * (/keywords) — the editor here is intentionally trimmed so writing
 * copy isn't crowded by chip rendering, Astro suggestions, or push UI.
 */
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { StudioEditor } from "@/components/metadata/StudioEditor";
import { MetadataToolbar } from "@/components/metadata/MetadataToolbar";
import { deriveTerritory } from "@/lib/keywordsFromMetadata";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export const dynamic = "force-dynamic";

export default async function MetadataPage({ params }: PageProps): Promise<JSX.Element> {
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
      const localizations = await prisma.appLocalization.findMany({
        where: { appId },
        orderBy: { locale: "asc" },
      });
      return { app, localizations };
    },
  );
  if (!data) notFound();

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            className="font-display text-2xl tracking-[-0.01em]"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            Metadata
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--ink-tertiary)]">
            Per-locale copy. Keywords field lives on the{" "}
            <strong>Keywords</strong> tab; performance lives on{" "}
            <strong>Analytics</strong>.
          </p>
        </div>
        <MetadataToolbar appId={data.app.id} />
      </header>

      <StudioEditor
        tenantSlug={tenantSlug}
        app={{
          id: data.app.id,
          platform: data.app.platform,
          primaryLocale: data.app.primaryLocale,
          appName: data.app.appName,
        }}
        initialLocalizations={data.localizations.map((l) => ({
          id: l.id,
          locale: l.locale,
          name: l.name,
          subtitle: l.subtitle,
          description: l.description,
          keywords: l.keywords,
          whatsNew: l.whatsNew,
          promotionalText: l.promotionalText,
          marketingUrl: l.marketingUrl,
          supportUrl: l.supportUrl,
          privacyPolicyUrl: l.privacyPolicyUrl,
          shortDescription: l.shortDescription,
          videoUrl: l.videoUrl,
          dirty: l.dirty,
          territory: deriveTerritory(l.locale),
        }))}
      />
    </div>
  );
}
