/**
 * SSE endpoint that forwards BullMQ progress events to the browser. The
 * underlying transport is Redis pub/sub (see packages/jobs/src/progress).
 *
 * Reverse proxies MUST disable buffering for this path (see nginx config).
 */
import { type NextRequest } from "next/server";
import { ForbiddenError, NotFoundError } from "@marquee/core";
import { prismaUnscoped } from "@marquee/db";
import { subscribeToProgress } from "@marquee/jobs";
import { getSessionFromCookie } from "@/lib/session";
import { assertAppAccess } from "@/lib/auth-helpers";

interface RouteContext { params: Promise<{ id: string }> }

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, context: RouteContext): Promise<Response> {
  const session = await getSessionFromCookie();
  if (!session) throw new ForbiddenError("Authentication required");
  const { id } = await context.params;

  // Authorise — job must belong to a tenant the user is a member of
  const job = await prismaUnscoped.job.findUnique({ where: { id } });
  if (!job) throw new NotFoundError("Job not found");
  const m = await prismaUnscoped.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId: job.tenantId, userId: session.userId } },
  });
  if (!m) throw new ForbiddenError("Not a member of this workspace");
  // Per-member app scoping (Job is not app-scoped at the RLS layer).
  if (job.appId) assertAppAccess(m.allowedAppIds, job.appId);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`event: open\ndata: ${JSON.stringify({ jobId: id })}\n\n`));
      try {
        for await (const event of subscribeToProgress(id)) {
          if (event.step === ":ping") {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
            continue;
          }
          controller.enqueue(
            encoder.encode(`event: progress\ndata: ${JSON.stringify(event)}\n\n`),
          );
          if (event.step === "completed" || event.step === "failed") {
            controller.close();
            return;
          }
        }
      } catch (err: unknown) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : "stream error" })}\n\n`,
          ),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
