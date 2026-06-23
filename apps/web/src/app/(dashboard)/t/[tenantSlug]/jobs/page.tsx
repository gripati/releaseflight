import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/shell/PageHeader";
import { LiveJobsTable, type JobSummary } from "@/components/jobs/LiveJobsTable";

interface PageProps {
  params: Promise<{ tenantSlug: string }>;
}

const PAGE_SIZE = 50;

/**
 * Jobs page. The shell + initial paint stay server-rendered so the
 * first byte is fast and authenticated against the request cookie,
 * but the table itself hands over to `<LiveJobsTable>` — a client
 * component that polls `/api/v1/jobs` to stream live updates and
 * exposes a per-row Cancel action with a confirmation modal.
 */
export default async function JobsPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const rows = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
    },
    async () =>
      prisma.job.findMany({
        orderBy: { createdAt: "desc" },
        take: PAGE_SIZE,
        select: {
          id: true,
          kind: true,
          status: true,
          progressCurrent: true,
          progressTotal: true,
          progressStep: true,
          appId: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
        },
      }),
  );

  const initialJobs: JobSummary[] = rows.map((j) => ({
    id: j.id,
    kind: j.kind,
    status: j.status,
    progress: {
      current: j.progressCurrent,
      total: j.progressTotal,
      step: j.progressStep,
    },
    appId: j.appId,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  }));

  return (
    <div className="page-loaded">
      <PageHeader
        title="Jobs"
        eyebrow={`${initialJobs.length.toString()} recent`}
        description="Background work — metadata pushes, screenshot uploads, AAB processing, Astro keyword analyses. Live updates every 2 s while jobs are running."
      />
      <LiveJobsTable initialJobs={initialJobs} pageSize={PAGE_SIZE} />
    </div>
  );
}
