import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { storage } from "@marquee/storage";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { loadAiOrchestrator, AiNotConfiguredError } from "@/lib/aiOrchestrator";
import { buildDiagnosisTask, extractLogExcerpt } from "@/lib/deployDiagnosis";
import { assertAiRateLimit } from "@/lib/rateLimitWrap";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; buildId: string }>;
}

/**
 * AI root-cause analysis of a FAILED build. Loads the build's log + context,
 * distils it to a token-bounded excerpt, and asks the tenant's configured AI
 * provider for a structured diagnosis (root cause, fix steps, copy-paste LLM
 * prompt). Only runs on failed builds.
 */
export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id: appId, buildId } = await context.params;
  await assertAiRateLimit(`${ctx.tenantContext.tenantId}:${appId}:build-analyze`);

  return withTenantContext(async () => {
    const build = await prisma.build.findFirst({ where: { id: buildId, appId } });
    if (!build) throw new NotFoundError("Build not found");
    if (build.status !== "FAILED") {
      throw new ValidationError("Only failed builds can be analysed.");
    }
    const app = await prisma.app.findFirst({ where: { id: appId } });
    if (!app) throw new NotFoundError("App not found");
    const cfg = await prisma.appBuildConfig.findUnique({ where: { appId } });

    // Pull the full log from storage if available; fall back to errorSummary.
    let fullLog = "";
    if (build.logsStorageKey) {
      try {
        fullLog = (await storage.get(build.logsStorageKey)).body.toString("utf8");
      } catch {
        /* log unavailable — excerpt falls back to errorSummary */
      }
    }
    const logExcerpt = extractLogExcerpt(fullLog, build.errorSummary);

    const orchestrator = await loadOrchestratorOrFriendlyError(ctx.tenant!.id);

    const task = buildDiagnosisTask({
      appName: app.appName,
      bundleId: app.bundleId,
      platform: build.platform,
      target: build.target,
      framework: build.frameworkDetected,
      failedPhase: build.failedPhase,
      teamId: app.teamId,
      localPath: cfg?.localPath ?? null,
      workdirSubpath: cfg?.workdirSubpath ?? null,
      errorSummary: build.errorSummary,
      logExcerpt,
    });

    const result = await orchestrator.run(task);
    if (!result.ok) {
      return NextResponse.json(
        { error: { code: result.code, message: result.message } },
        { status: result.retriable ? 503 : 400 },
      );
    }

    return NextResponse.json({
      diagnosis: result.output,
      meta: {
        provider: result.provider,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs: result.latencyMs,
      },
    });
  });
});

async function loadOrchestratorOrFriendlyError(tenantId: string) {
  try {
    const { orchestrator } = await loadAiOrchestrator(tenantId);
    return orchestrator;
  } catch (err) {
    if (err instanceof AiNotConfiguredError) throw err; // withApiErrors → 400 AI_NOT_CONFIGURED
    throw err;
  }
}
