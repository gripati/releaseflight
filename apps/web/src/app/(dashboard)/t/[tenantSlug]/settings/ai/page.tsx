import { notFound } from "next/navigation";
import { tenantStorage } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import {
  loadAiChainConfig,
  listConfiguredProviders,
} from "@/lib/aiOrchestrator";
import { AiSettingsPanel } from "@/components/settings/AiSettingsPanel";
import { PageHeader } from "@/components/shell/PageHeader";

interface PageProps {
  params: Promise<{ tenantSlug: string }>;
}

export const dynamic = "force-dynamic";

export default async function AiSettingsPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const { config, configured } = await tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () => ({
      config: await loadAiChainConfig(tenant.id),
      configured: await listConfiguredProviders(tenant.id),
    }),
  );

  return (
    <div className="page-loaded space-y-8">
      <PageHeader title="AI providers" eyebrow={`Settings · ${tenant.slug}`} />
      <AiSettingsPanel initialConfig={config} initialConfigured={configured} />
    </div>
  );
}
