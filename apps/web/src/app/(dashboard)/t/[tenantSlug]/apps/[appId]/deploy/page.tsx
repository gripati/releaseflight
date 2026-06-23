import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { DeployPanel } from "@/components/deploy/DeployPanel";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export default async function DeployPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const app = await tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () => prisma.app.findUnique({ where: { id: appId } }),
  );
  if (!app) notFound();

  return <DeployPanel appId={app.id} platform={app.platform} appName={app.appName} />;
}
