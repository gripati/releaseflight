/**
 * Snapshot the post-push state of an app's localized metadata.
 *
 * Called immediately after a successful `metadata.push` so that the
 * "keyword stock market" can later overlay every push event on the
 * downloads/PVCR timeline and reason about what changed at that
 * moment. One row per locale per push.
 *
 * We read the current `AppLocalization` rows (just-updated, lastPushedAt
 * close to now) rather than the in-flight push payload — that way the
 * snapshot reflects what actually landed in the store, not what we
 * asked for.
 */
import { prisma } from "@marquee/db";

export async function recordMetadataSnapshot(params: {
  tenantId: string;
  appId: string;
  /** Only snapshot these locales — usually all that were just pushed. */
  locales: string[];
  pushedById: string;
  pushedAt?: Date;
}): Promise<{ count: number }> {
  const pushedAt = params.pushedAt ?? new Date();
  if (params.locales.length === 0) return { count: 0 };

  const rows = await prisma.appLocalization.findMany({
    where: { appId: params.appId, locale: { in: params.locales } },
    select: {
      locale: true,
      name: true,
      subtitle: true,
      keywords: true,
      description: true,
      promotionalText: true,
      shortDescription: true,
    },
  });
  if (rows.length === 0) return { count: 0 };

  await prisma.metadataSnapshot.createMany({
    data: rows.map((r) => ({
      tenantId: params.tenantId,
      appId: params.appId,
      locale: r.locale,
      pushedAt,
      name: r.name,
      subtitle: r.subtitle,
      keywordsField: r.keywords,
      description: r.description,
      promotionalText: r.promotionalText,
      shortDescription: r.shortDescription,
      pushedById: params.pushedById,
    })),
  });
  return { count: rows.length };
}
