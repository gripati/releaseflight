/**
 * Release Flight build runner — macOS agent.
 *
 * Unlike the Linux worker (apps/worker), this process runs natively on macOS
 * because iOS builds need Xcode (`xcodebuild`, `xcrun altool`), which cannot
 * run on Linux. It is the ONLY component that touches Xcode/Gradle/CocoaPods.
 *
 * It consumes the `build.run` BullMQ queue (concurrency 1 — one Xcode/Gradle
 * build at a time per machine), registers itself as a `Runner` row with a
 * heartbeat, and streams build progress/logs back through the shared
 * `publishProgress` → Redis pub/sub → web SSE pipeline.
 */
import "./env"; // MUST be first — loads root .env before any secret/db import.
import os from "node:os";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { prismaUnscoped, assertDbRoleRespectsRls } from "@marquee/db";
import {
  runWith,
  dbIdOf,
  markCompleted,
  markFailed,
  type BuildRunJobData,
} from "@marquee/jobs";
import { probeToolchain, type Toolchain } from "./toolchain/probe";
import { processBuildRun } from "./processBuildRun";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV !== "production" ? { target: "pino-pretty" } : undefined,
});

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const RUNNER_NAME = process.env.RUNNER_NAME ?? "local";
const HOSTNAME = os.hostname();
const HEARTBEAT_MS = 30_000;

function capabilitiesFromToolchain(tc: Toolchain): { ios: boolean; android: boolean } {
  return {
    // iOS requires macOS + Xcode.
    ios: os.platform() === "darwin" && tc.xcodebuild != null,
    // Android requires a JDK; the Android SDK is validated lazily at build time.
    android: tc.java != null,
  };
}

async function upsertRunner(
  status: "ONLINE" | "OFFLINE" | "DRAINING",
  toolchain: Toolchain,
): Promise<string> {
  const capabilities = capabilitiesFromToolchain(toolchain);
  const runner = await prismaUnscoped.runner.upsert({
    where: { hostname_name: { hostname: HOSTNAME, name: RUNNER_NAME } },
    create: {
      name: RUNNER_NAME,
      hostname: HOSTNAME,
      os: os.platform(),
      status,
      capabilities,
      toolchain: { ...toolchain },
      version: process.env.npm_package_version ?? null,
      lastHeartbeatAt: new Date(),
    },
    update: {
      status,
      capabilities,
      toolchain: { ...toolchain },
      lastHeartbeatAt: new Date(),
    },
    select: { id: true },
  });
  return runner.id;
}

async function main(): Promise<void> {
  // Boot guard — refuse to start in prod if the DB role bypasses RLS.
  await assertDbRoleRespectsRls();

  const toolchain = await probeToolchain();
  const caps = capabilitiesFromToolchain(toolchain);
  const runnerId = await upsertRunner("ONLINE", toolchain);
  logger.info(
    { runnerId, hostname: HOSTNAME, name: RUNNER_NAME, caps, toolchain },
    "build runner online",
  );

  const heartbeat = setInterval(() => {
    void prismaUnscoped.runner
      .update({
        where: { id: runnerId },
        data: { status: "ONLINE", lastHeartbeatAt: new Date() },
      })
      .catch((err: unknown) =>
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "heartbeat failed"),
      );
  }, HEARTBEAT_MS);

  const worker = new Worker<BuildRunJobData>(
    "build.run",
    (job) => runWith<BuildRunJobData>(job, (input) => processBuildRun(input, { runnerId })),
    { connection, concurrency: 1 },
  );
  worker.on("completed", (job, result) => {
    const id = dbIdOf(job);
    if (id) void markCompleted(id, result);
  });
  worker.on("failed", (job, err) => {
    const id = dbIdOf(job);
    if (id) void markFailed(id, err, logger);
  });
  worker.on("error", (err) => logger.error({ err: err.message }, "build.run worker error"));

  logger.info("listening on build.run queue (concurrency 1)");

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, "shutting down build runner");
    clearInterval(heartbeat);
    try {
      await worker.close();
      await upsertRunner("OFFLINE", toolchain);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "shutdown cleanup failed");
    } finally {
      await connection.quit().catch(() => undefined);
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.stack : String(err) }, "build runner failed to start");
  process.exit(1);
});
