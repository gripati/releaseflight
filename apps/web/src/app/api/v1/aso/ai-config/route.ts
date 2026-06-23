/**
 * GET  /api/v1/aso/ai-config   — current chain + which kinds have creds
 * PUT  /api/v1/aso/ai-config   — save a new chain (primary + fallbacks)
 *
 * The chain is whatever the user submits. We only validate that:
 *   • primary references a provider kind they have an active credential for
 *   • fallbacks reference distinct kinds they have credentials for
 *   • fallbacks don't repeat the primary
 *
 * There is no implicit ordering — the user's array order is persisted
 * verbatim and replayed by the orchestrator.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ValidationError } from "@marquee/core";
import { AiChainConfigSchema, AI_PROVIDER_KINDS, type AiProviderKind } from "@marquee/aso";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import {
  loadAiChainConfig,
  saveAiChainConfig,
  listConfiguredProviders,
} from "@/lib/aiOrchestrator";

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async () => {
  const ctx = await requireTenant();
  return withTenantContext(async () => {
    const [config, configured] = await Promise.all([
      loadAiChainConfig(ctx.tenant!.id),
      listConfiguredProviders(ctx.tenant!.id),
    ]);
    return NextResponse.json({
      config,
      configured,
      availableKinds: AI_PROVIDER_KINDS,
    });
  });
});

export const PUT = withApiErrors(async (req: NextRequest) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "ADMIN");
  const body = (await req.json()) as unknown;
  const parsed = AiChainConfigSchema.parse(body);

  return withTenantContext(async () => {
    const configured = await listConfiguredProviders(ctx.tenant!.id);
    const configuredKinds = new Set(configured.map((c) => c.kind));
    const referenced: AiProviderKind[] = [parsed.primary, ...parsed.fallbacks];
    for (const kind of referenced) {
      if (!configuredKinds.has(kind)) {
        throw new ValidationError(
          `No active credential for ${kind} — add one in Credentials before assigning it to the chain.`,
        );
      }
    }
    const saved = await saveAiChainConfig(ctx.tenant!.id, parsed);
    return NextResponse.json({ config: saved });
  });
});
