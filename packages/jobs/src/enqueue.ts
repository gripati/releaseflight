import { prisma, prismaUnscoped, getCurrentTenantId } from "@marquee/db";
import { queues, type JobDataMap, type QueueName } from "./queues";

export interface EnqueueOptions {
  idempotencyKey?: string;
  appId?: string;
}

/**
 * Enqueue a job idempotently.
 *
 * Flow:
 *   1. Compute the BullMQ jobId — derived from idempotencyKey when set
 *      so retries deduplicate. BullMQ ≥ 5 rejects ":" in jobIds so we
 *      sanitize.
 *   2. Look up any existing DB Job row carrying that bullJobId. If a
 *      live (not COMPLETED/FAILED) row exists, return it without
 *      enqueuing again. If a terminal one exists (FAILED/COMPLETED),
 *      we clear its bullJobId so the unique constraint frees up for
 *      this fresh attempt.
 *   3. Create a new DB Job row in QUEUED.
 *   4. queue.add(jobId) — BullMQ deduplicates by jobId so a still-
 *      pending one just returns the existing reference.
 *   5. Stamp the new DB row's bullJobId so the worker can resolve it
 *      back via `where: { bullJobId }`.
 */
export async function enqueue<K extends QueueName>(
  name: K,
  data: JobDataMap[K],
  opts: EnqueueOptions = {},
): Promise<{ jobId: string; bullJobId: string; reused: boolean }> {
  const tenantId = getCurrentTenantId();

  // 1. Decide on the BullMQ jobId up-front.
  const rawJobId = opts.idempotencyKey ? `idem-${opts.idempotencyKey}` : null;
  const safeJobId = rawJobId ? rawJobId.replace(/:/g, "--") : null;

  // 2. If the caller passed an idempotency key, see if a prior attempt
  //    is still alive. We use prismaUnscoped here because the unique
  //    `bullJobId` lookup must work regardless of which tenant context
  //    is currently active — but we filter by tenantId below to keep
  //    isolation.
  if (safeJobId) {
    const existing = await prismaUnscoped.job.findUnique({
      where: { bullJobId: safeJobId },
    });
    if (existing?.tenantId === tenantId) {
      if (existing.status === "QUEUED" || existing.status === "RUNNING") {
        return { jobId: existing.id, bullJobId: safeJobId, reused: true };
      }
      // Terminal — free the DB unique slot AND wipe the BullMQ entry
      // so `queue.add(jobId)` accepts a fresh run. BullMQ dedupes by
      // jobId across waiting/active/completed/failed; without this
      // cleanup a previously-COMPLETED job under the same idempotency
      // key just returns the old reference and never re-runs.
      await prismaUnscoped.job.update({
        where: { id: existing.id },
        data: { bullJobId: null },
      });
      try {
        const q = queues[name] as {
          getJob?: (id: string) => Promise<{ remove: () => Promise<void> } | undefined>;
        };
        const stale = await q.getJob?.(safeJobId);
        if (stale) await stale.remove();
      } catch {
        // Best-effort — BullMQ may have already swept the entry.
      }
    }
  }

  // 3. Create the durable Job row.
  const dbJob = await prisma.job.create({
    data: {
      tenantId,
      userId: (data as unknown as { userId: string }).userId,
      appId: opts.appId ?? null,
      kind: name,
      status: "QUEUED",
      payload: data as unknown as object,
      progressTotal: 1,
      idempotencyKey: opts.idempotencyKey ?? null,
    },
  });

  // 4. Stamp the `bullJobId` BEFORE enqueuing so the worker can
  //    resolve it from millisecond zero. BullMQ notifies workers the
  //    moment `queue.add` returns — if the DB update happened after,
  //    a fast worker would race in, find a row without `bullJobId`,
  //    fall back to the raw idem-string, and publishProgress would
  //    blow up trying to use that string as a UUID.
  const finalJobId = safeJobId ?? dbJob.id;
  await prisma.job.update({
    where: { id: dbJob.id },
    data: { bullJobId: finalJobId },
  });

  // 5. Enqueue in BullMQ.
  const queue = queues[name] as {
    add: (n: string, d: unknown, o: { jobId: string }) => Promise<{ id?: string }>;
  };
  const bullJob = await queue.add(name, data, { jobId: finalJobId });
  return { jobId: dbJob.id, bullJobId: bullJob.id ?? finalJobId, reused: false };
}

export async function getJob(jobId: string): Promise<{
  id: string;
  status: string;
  progress: { current: number; total: number; step: string | null };
  result: unknown;
  error: unknown;
} | null> {
  const j = await prisma.job.findUnique({ where: { id: jobId } });
  if (!j) return null;
  return {
    id: j.id,
    status: j.status,
    progress: { current: j.progressCurrent, total: j.progressTotal, step: j.progressStep },
    result: j.result,
    error: j.error,
  };
}

export async function getJobStatus(jobId: string): Promise<string | null> {
  const j = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  return j?.status ?? null;
}
