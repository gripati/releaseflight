/**
 * Cooperative-cancellation contract tests.
 *
 * These cover the two halves of the cancel design:
 *   • `publishProgress` THROWS `JobCancelledError` when the row has
 *     been flipped to CANCELLED out-of-band (by `cancelJob`). The
 *     worker uses this signal to unwind early.
 *   • `cancelJob` is idempotent — it returns `{ cancelled: false }`
 *     when the job is already in a terminal state.
 *
 * Prisma + Redis are mocked at the module level so the tests stay
 * deterministic and fast — no DB / Redis required.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ── Module mocks ───────────────────────────────────────────────────────
// We mock the WHOLE @marquee/cache + @marquee/db surfaces with the bare
// minimum the progress module touches, so we control every IO call.

const jobStore = new Map<
  string,
  {
    id: string;
    kind: string;
    status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
    bullJobId: string | null;
    finishedAt: Date | null;
    error: unknown;
    progressCurrent: number;
    progressTotal: number;
    progressStep: string | null;
  }
>();

const redisCalls = {
  publish: [] as { channel: string; message: string }[],
  rpush: [] as { key: string; value: string }[],
};

vi.mock("@marquee/cache", () => ({
  redis: {
    rpush: (key: string, value: string) => {
      redisCalls.rpush.push({ key, value });
      return Promise.resolve(1);
    },
    ltrim: () => Promise.resolve("OK"),
    expire: () => Promise.resolve(1),
    lrange: () => Promise.resolve([]),
  },
  redisPublisher: {
    publish: (channel: string, message: string) => {
      redisCalls.publish.push({ channel, message });
      return Promise.resolve(0);
    },
  },
  redisSubscriber: {},
}));

vi.mock("@marquee/db", () => ({
  prismaUnscoped: {
    job: {
      updateMany: ({
        where,
        data,
      }: {
        where: { id: string; status?: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        const row = jobStore.get(where.id);
        if (!row) return Promise.resolve({ count: 0 });
        if (where.status && !where.status.in.includes(row.status)) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = jobStore.get(where.id);
        if (!row) return Promise.reject(new Error("not found"));
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      findUnique: ({
        where,
        select,
      }: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) => {
        const row = jobStore.get(where.id);
        if (!row) return Promise.resolve(null);
        if (!select) return Promise.resolve(row);
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(select)) {
          if (select[k]) out[k] = (row as unknown as Record<string, unknown>)[k];
        }
        return Promise.resolve(out);
      },
    },
  },
}));

// Mock the queues so cancelJob can attempt queue.remove without
// actually touching BullMQ. We capture the remove() calls for asserts.
const removedFromQueue: string[] = [];
vi.mock("../queues", () => ({
  queues: {
    "metadata.fetch": { remove: (id: string) => { removedFromQueue.push(id); return Promise.resolve(); } },
    "metadata.push": { remove: (id: string) => { removedFromQueue.push(id); return Promise.resolve(); } },
    "screenshot.upload": { remove: (id: string) => { removedFromQueue.push(id); return Promise.resolve(); } },
    "aso.analytics.sync": { remove: (id: string) => { removedFromQueue.push(id); return Promise.resolve(); } },
    "aso.astro.analyze": { remove: (id: string) => { removedFromQueue.push(id); return Promise.resolve(); } },
  },
}));

// ── Subject under test ─────────────────────────────────────────────────
import { cancelJob, publishProgress, JobCancelledError } from "../progress";

beforeEach(() => {
  jobStore.clear();
  redisCalls.publish.length = 0;
  redisCalls.rpush.length = 0;
  removedFromQueue.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("JobCancelledError", () => {
  test("has the right name + code + message", () => {
    const e = new JobCancelledError("job-123");
    expect(e.name).toBe("JobCancelledError");
    expect(e.code).toBe("JOB_CANCELLED");
    expect(e.jobId).toBe("job-123");
    expect(e.message).toContain("job-123");
    expect(e instanceof Error).toBe(true);
  });
});

describe("publishProgress — cooperative cancellation", () => {
  test("RUNNING job: writes progress + emits live event", async () => {
    jobStore.set("j1", {
      id: "j1",
      kind: "aso.astro.analyze",
      status: "RUNNING",
      bullJobId: "j1",
      finishedAt: null,
      error: null,
      progressCurrent: 0,
      progressTotal: 10,
      progressStep: null,
    });
    await publishProgress({
      jobId: "j1",
      current: 3,
      total: 10,
      step: "Analysing US (3/10)",
    });
    const row = jobStore.get("j1")!;
    expect(row.progressCurrent).toBe(3);
    expect(row.progressStep).toBe("Analysing US (3/10)");
    expect(redisCalls.publish).toHaveLength(1);
    expect(redisCalls.publish[0]!.channel).toBe("jobs:j1");
  });

  test("CANCELLED job: throws JobCancelledError and skips live event", async () => {
    jobStore.set("j1", {
      id: "j1",
      kind: "aso.astro.analyze",
      status: "CANCELLED",
      bullJobId: "j1",
      finishedAt: new Date(),
      error: { code: "USER_CANCELLED" },
      progressCurrent: 5,
      progressTotal: 10,
      progressStep: "Analysing TR",
    });
    await expect(
      publishProgress({
        jobId: "j1",
        current: 6,
        total: 10,
        step: "Analysing UK",
      }),
    ).rejects.toBeInstanceOf(JobCancelledError);
    // Live event was NOT emitted — worker has been told to halt.
    expect(redisCalls.publish).toHaveLength(0);
    // Progress was NOT advanced (updateMany skipped because status not in QUEUED/RUNNING)
    expect(jobStore.get("j1")!.progressCurrent).toBe(5);
    expect(jobStore.get("j1")!.progressStep).toBe("Analysing TR");
  });

  test("missing job row: silently skips (no throw)", async () => {
    await expect(
      publishProgress({ jobId: "no-such-job", current: 1, total: 2, step: "x" }),
    ).resolves.toBeUndefined();
    // No live event — there's no job to track
    expect(redisCalls.publish).toHaveLength(0);
  });

  test("COMPLETED job: silently no-ops without throwing", async () => {
    // Once a job is COMPLETED, late progress publishes (from a worker
    // still unwinding finalizers) should NOT throw or emit events.
    jobStore.set("j1", {
      id: "j1",
      kind: "metadata.push",
      status: "COMPLETED",
      bullJobId: "j1",
      finishedAt: new Date(),
      error: null,
      progressCurrent: 10,
      progressTotal: 10,
      progressStep: "completed",
    });
    await expect(
      publishProgress({ jobId: "j1", current: 10, total: 10, step: "done" }),
    ).resolves.toBeUndefined();
    expect(redisCalls.publish).toHaveLength(0);
  });
});

describe("cancelJob — flip + cleanup", () => {
  test("RUNNING job: flips to CANCELLED, removes from BullMQ, publishes notice", async () => {
    jobStore.set("j-running", {
      id: "j-running",
      kind: "aso.astro.analyze",
      status: "RUNNING",
      bullJobId: "j-running",
      finishedAt: null,
      error: null,
      progressCurrent: 8,
      progressTotal: 37,
      progressStep: "Analysing TR (8/37)",
    });
    const result = await cancelJob("j-running", {
      reason: "User clicked X on /jobs",
      userId: "user-1",
    });
    expect(result).toEqual({ cancelled: true, status: "CANCELLED" });
    const row = jobStore.get("j-running")!;
    expect(row.status).toBe("CANCELLED");
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.error).toEqual({
      code: "USER_CANCELLED",
      message: "User clicked X on /jobs",
      userId: "user-1",
    });
    // BullMQ cleanup
    expect(removedFromQueue).toEqual(["j-running"]);
    // Final cancellation notice published
    expect(redisCalls.publish).toHaveLength(1);
    expect(redisCalls.publish[0]!.channel).toBe("jobs:j-running");
    const payload = JSON.parse(redisCalls.publish[0]!.message) as {
      step: string;
      level: string;
    };
    expect(payload.step).toBe("cancelled");
    expect(payload.level).toBe("warn");
  });

  test("QUEUED job: also gets cancelled cleanly", async () => {
    jobStore.set("j-queued", {
      id: "j-queued",
      kind: "metadata.push",
      status: "QUEUED",
      bullJobId: "j-queued",
      finishedAt: null,
      error: null,
      progressCurrent: 0,
      progressTotal: 1,
      progressStep: null,
    });
    const result = await cancelJob("j-queued");
    expect(result).toEqual({ cancelled: true, status: "CANCELLED" });
    expect(jobStore.get("j-queued")!.status).toBe("CANCELLED");
  });

  test("already-COMPLETED job: returns cancelled=false, leaves row untouched", async () => {
    jobStore.set("j-done", {
      id: "j-done",
      kind: "metadata.push",
      status: "COMPLETED",
      bullJobId: "j-done",
      finishedAt: new Date("2026-01-01"),
      error: null,
      progressCurrent: 10,
      progressTotal: 10,
      progressStep: "completed",
    });
    const result = await cancelJob("j-done");
    expect(result).toEqual({ cancelled: false, status: "COMPLETED" });
    expect(jobStore.get("j-done")!.status).toBe("COMPLETED");
    expect(removedFromQueue).toEqual([]);
    expect(redisCalls.publish).toEqual([]);
  });

  test("already-FAILED job: also idempotent, no side effects", async () => {
    jobStore.set("j-failed", {
      id: "j-failed",
      kind: "aso.astro.analyze",
      status: "FAILED",
      bullJobId: "j-failed",
      finishedAt: new Date("2026-01-01"),
      error: { message: "boom" },
      progressCurrent: 5,
      progressTotal: 10,
      progressStep: "failed",
    });
    const result = await cancelJob("j-failed");
    expect(result).toEqual({ cancelled: false, status: "FAILED" });
    expect(removedFromQueue).toEqual([]);
  });

  test("already-CANCELLED job: idempotent on second call", async () => {
    jobStore.set("j-cancelled", {
      id: "j-cancelled",
      kind: "aso.astro.analyze",
      status: "CANCELLED",
      bullJobId: "j-cancelled",
      finishedAt: new Date("2026-01-01"),
      error: { code: "USER_CANCELLED" },
      progressCurrent: 5,
      progressTotal: 10,
      progressStep: "cancelled",
    });
    const result = await cancelJob("j-cancelled");
    expect(result).toEqual({ cancelled: false, status: "CANCELLED" });
  });

  test("unknown job: returns NOT_FOUND", async () => {
    const result = await cancelJob("does-not-exist");
    expect(result).toEqual({ cancelled: false, status: "NOT_FOUND" });
    expect(removedFromQueue).toEqual([]);
  });

  test("end-to-end: publishProgress AFTER cancelJob throws JobCancelledError", async () => {
    // The full cooperative-cancel happy path: user clicks cancel
    // mid-run, the next progress publish from the worker observes the
    // CANCELLED row and throws so the worker can unwind.
    jobStore.set("j-coop", {
      id: "j-coop",
      kind: "aso.astro.analyze",
      status: "RUNNING",
      bullJobId: "j-coop",
      finishedAt: null,
      error: null,
      progressCurrent: 3,
      progressTotal: 10,
      progressStep: "Analysing US",
    });
    const cancelResult = await cancelJob("j-coop");
    expect(cancelResult.cancelled).toBe(true);
    // Now the worker (oblivious to the cancel) tries to publish progress
    await expect(
      publishProgress({
        jobId: "j-coop",
        current: 4,
        total: 10,
        step: "Analysing UK",
      }),
    ).rejects.toBeInstanceOf(JobCancelledError);
  });
});
