/**
 * Shared BullMQ job lifecycle helpers.
 *
 * The Linux worker (apps/worker) and the macOS build runner (apps/runner)
 * both consume BullMQ queues and need identical DB-row bookkeeping:
 * resolve the durable Job row from the BullMQ jobId, mark it RUNNING,
 * then COMPLETED / FAILED — honouring cooperative cancellation.
 *
 * These were originally inlined in apps/worker/src/index.ts; they live here
 * so the runner reuses the exact same logic instead of copy-pasting it.
 */
import { prismaUnscoped } from "@marquee/db";
import { publishProgress, JobCancelledError } from "./progress";

interface Logger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const consoleLogger: Logger = {
  info: (obj, msg) => console.log(msg ?? "", obj),
  error: (obj, msg) => console.error(msg ?? "", obj),
};

/**
 * BullMQ's `job.id` is no longer the DB row's UUID (idempotency keys +
 * BullMQ ≥5 forbidding ':' in jobIds force `idem-…` prefixes). Resolve once
 * via the unique `bullJobId` column so processors, publishProgress and the
 * SSE relay all keep speaking real Job UUIDs.
 */
export async function resolveDbJobId(bullJobId: string): Promise<string | null> {
  const row = await prismaUnscoped.job.findUnique({
    where: { bullJobId },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function markRunning(dbJobId: string): Promise<void> {
  try {
    await prismaUnscoped.job.update({
      where: { id: dbJobId },
      data: { status: "RUNNING", startedAt: new Date() },
    });
  } catch {
    /* job row may not exist if the API skipped the DB write */
  }
}

export async function markCompleted(dbJobId: string, result: unknown): Promise<void> {
  // Round-trip through JSON so non-serialisable values (Date, undefined,
  // functions) don't reach Prisma's Json column.
  const safe = JSON.parse(JSON.stringify(result ?? {})) as unknown;
  // Conditional update — never clobber a CANCELLED/terminal status.
  await prismaUnscoped.job
    .updateMany({
      where: { id: dbJobId, status: { in: ["QUEUED", "RUNNING"] } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { status: "COMPLETED", result: safe as any, finishedAt: new Date() },
    })
    .catch(() => undefined);
  try {
    await publishProgress({
      jobId: dbJobId,
      current: 1,
      total: 1,
      step: "completed",
      level: "info",
    });
  } catch (err: unknown) {
    if (!(err instanceof JobCancelledError)) throw err;
  }
}

export async function markFailed(
  dbJobId: string,
  err: Error,
  logger: Logger = consoleLogger,
): Promise<void> {
  if (err instanceof JobCancelledError) {
    logger.info({ jobId: dbJobId }, "Job cancelled by user — runner unwound cleanly");
    return;
  }
  await prismaUnscoped.job
    .updateMany({
      where: { id: dbJobId, status: { in: ["QUEUED", "RUNNING"] } },
      data: {
        status: "FAILED",
        error: { message: err.message, name: err.name },
        finishedAt: new Date(),
      },
    })
    .catch(() => undefined);
  try {
    await publishProgress({
      jobId: dbJobId,
      current: 0,
      total: 1,
      step: "failed",
      level: "error",
      detail: err.message,
    });
  } catch (e: unknown) {
    if (!(e instanceof JobCancelledError)) throw e;
  }
}

/**
 * Resolve the DB job id, mark RUNNING, stash the resolved id on the job
 * object (so the completed/failed callbacks can read it back), then run the
 * processor with `{ ...job.data, jobId }`.
 */
export async function runWith<TData>(
  job: { id?: string; data: TData },
  processor: (input: TData & { jobId: string }) => Promise<unknown>,
): Promise<unknown> {
  const bullJobId = job.id!;
  const dbJobId = (await resolveDbJobId(bullJobId)) ?? bullJobId;
  await markRunning(dbJobId);
  (job as { _dbJobId?: string })._dbJobId = dbJobId;
  return processor({ ...job.data, jobId: dbJobId });
}

export function dbIdOf(job: { id?: string; _dbJobId?: string } | undefined): string | null {
  if (!job) return null;
  return job._dbJobId ?? job.id ?? null;
}
