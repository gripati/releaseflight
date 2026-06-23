/**
 * Job progress pub/sub. Writes to two places:
 *   • Postgres Job row — durable history for audit + reload
 *   • Redis pub/sub  — live SSE stream
 */
import { redis, redisPublisher, redisSubscriber } from "@marquee/cache";
import { prismaUnscoped } from "@marquee/db";

export interface JobProgress {
  jobId: string;
  current: number;
  total: number;
  step: string;
  detail?: unknown;
  level?: "info" | "warn" | "error";
}

const CHANNEL_PREFIX = "jobs:";

/** Thrown by {@link publishProgress} when the job has been marked
 *  CANCELLED out-of-band (typically by the user via the cancel
 *  endpoint). Worker code may catch this to exit cleanly, but the
 *  default behaviour is to let it bubble up — BullMQ will mark the
 *  Bull job as failed, and the DB row is already CANCELLED so the
 *  UI shows the correct terminal state.
 *
 *  This is the COOPERATIVE half of cancellation: progress events fire
 *  often enough (once per territory / locale / batch) that the worker
 *  notices a cancel within seconds, without us having to inject
 *  AbortSignal plumbing through every async helper. */
export class JobCancelledError extends Error {
  readonly code = "JOB_CANCELLED";
  constructor(public readonly jobId: string) {
    super(`Job ${jobId} was cancelled`);
    this.name = "JobCancelledError";
  }
}

export const progress = {
  publish: publishProgress,
  subscribe: subscribeToProgress,
};

export async function publishProgress(p: JobProgress): Promise<void> {
  // Cooperative cancellation — every progress tick is a chance for the
  // worker to notice a cancel request. We attempt a conditional update
  // (`status: { in: ['QUEUED', 'RUNNING'] }`) so we only touch the row
  // when it's still alive; if the row has already moved to CANCELLED
  // we throw JobCancelledError so the worker can unwind early.
  try {
    const updated = await prismaUnscoped.job.updateMany({
      where: {
        id: p.jobId,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      data: {
        progressCurrent: p.current,
        progressTotal: p.total,
        progressStep: p.step,
      },
    });
    if (updated.count === 0) {
      // Row either missing OR in a terminal state. Distinguish so we
      // only throw cancellation, not "job vanished".
      const current = await prismaUnscoped.job.findUnique({
        where: { id: p.jobId },
        select: { status: true },
      });
      if (current?.status === "CANCELLED") {
        throw new JobCancelledError(p.jobId);
      }
      // Otherwise: job row missing or already COMPLETED/FAILED —
      // silently skip the live event too so we don't push progress
      // updates onto a closed lifecycle.
      return;
    }
  } catch (err: unknown) {
    if (err instanceof JobCancelledError) throw err;
    /* job row may not exist yet or transient DB hiccup — best effort */
  }

  // Live SSE
  await redisPublisher.publish(`${CHANNEL_PREFIX}${p.jobId}`, JSON.stringify(p));

  // Capped history list (last 100 events) for reconnect
  await redis.rpush(`${CHANNEL_PREFIX}${p.jobId}:hist`, JSON.stringify(p));
  await redis.ltrim(`${CHANNEL_PREFIX}${p.jobId}:hist`, -100, -1);
  await redis.expire(`${CHANNEL_PREFIX}${p.jobId}:hist`, 24 * 60 * 60);
}

/**
 * Mark a job as CANCELLED and remove it from BullMQ.
 *
 * Idempotent — calling on a job that's already CANCELLED / COMPLETED /
 * FAILED returns the existing row unchanged. Auth is the caller's
 * responsibility (we don't know which tenant the caller belongs to
 * here — the API route checks membership before calling this).
 *
 * Returns `{ cancelled: true, reason? }` on a real cancel, or
 * `{ cancelled: false, status }` if the job was already terminal.
 */
export async function cancelJob(
  jobId: string,
  opts: { reason?: string; userId?: string } = {},
): Promise<{ cancelled: boolean; status: string }> {
  const row = await prismaUnscoped.job.findUnique({
    where: { id: jobId },
    select: { id: true, kind: true, status: true, bullJobId: true },
  });
  if (!row) {
    return { cancelled: false, status: "NOT_FOUND" };
  }
  if (row.status !== "QUEUED" && row.status !== "RUNNING") {
    return { cancelled: false, status: row.status };
  }

  // 1. Flip DB row to CANCELLED with a structured error payload. This
  //    is what the UI reads; the worker (when it next publishes
  //    progress) will see the change and throw JobCancelledError.
  await prismaUnscoped.job.update({
    where: { id: jobId },
    data: {
      status: "CANCELLED",
      finishedAt: new Date(),
      error: {
        code: "USER_CANCELLED",
        message: opts.reason ?? "Cancelled by user",
        ...(opts.userId && { userId: opts.userId }),
      },
    },
  });

  // 2. Remove from BullMQ so it won't be re-attempted. `queue.remove`
  //    is a no-op if the job has already moved past `waiting` —
  //    that's fine; cooperative cancel handles the active case.
  if (row.bullJobId) {
    try {
      const { queues } = await import("./queues");
      const queue = queues[row.kind as keyof typeof queues];
      if (queue && "remove" in queue) {
        await queue.remove(row.bullJobId);
      }
    } catch {
      /* best effort — DB cancel is the source of truth */
    }
  }

  // 3. Publish a final progress event so any open SSE subscribers
  //    receive a cancellation notice and close the stream. Use the
  //    raw Redis path to avoid the cancellation-check loop in
  //    publishProgress (which would throw on the already-cancelled row).
  try {
    const payload: JobProgress = {
      jobId,
      current: 0,
      total: 0,
      step: "cancelled",
      level: "warn",
    };
    await redisPublisher.publish(
      `${CHANNEL_PREFIX}${jobId}`,
      JSON.stringify(payload),
    );
    await redis.rpush(`${CHANNEL_PREFIX}${jobId}:hist`, JSON.stringify(payload));
    await redis.ltrim(`${CHANNEL_PREFIX}${jobId}:hist`, -100, -1);
  } catch {
    /* live channel is best-effort */
  }

  return { cancelled: true, status: "CANCELLED" };
}

export async function* subscribeToProgress(
  jobId: string,
  opts: { sinceIndex?: number } = {},
): AsyncIterableIterator<JobProgress> {
  // Replay history first
  const hist = await redis.lrange(`${CHANNEL_PREFIX}${jobId}:hist`, opts.sinceIndex ?? 0, -1);
  for (const raw of hist) {
    try {
      yield JSON.parse(raw) as JobProgress;
    } catch {
      /* ignore malformed */
    }
  }

  // Then stream live events via pub/sub
  const channel = `${CHANNEL_PREFIX}${jobId}`;
  const sub = redisSubscriber.duplicate();
  await sub.subscribe(channel);

  try {
    while (true) {
      const message = await new Promise<string | null>((resolve) => {
        const onMessage = (chan: string, msg: string): void => {
          if (chan === channel) {
            sub.off("message", onMessage);
            resolve(msg);
          }
        };
        sub.on("message", onMessage);
        // Watchdog so the generator doesn't leak if no messages arrive
        setTimeout(() => {
          sub.off("message", onMessage);
          resolve(null);
        }, 30_000);
      });
      if (!message) {
        yield { jobId, current: 0, total: 0, step: ":ping" };
        continue;
      }
      try {
        yield JSON.parse(message) as JobProgress;
      } catch {
        /* malformed */
      }
    }
  } finally {
    await sub.unsubscribe(channel);
    await sub.quit();
  }
}
