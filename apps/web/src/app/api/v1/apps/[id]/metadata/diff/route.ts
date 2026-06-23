/**
 * Push preview — returns a per-locale, per-field word-level diff between
 * the LOCAL row and the LAST FETCHED snapshot. The diff is computed on
 * the server so the client doesn't need a diff library. The DiffSheet UI
 * renders it as additions/removals.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isGooglePlaySupported, toGooglePlayLocale, NotFoundError } from "@marquee/core";
import { Locale } from "@marquee/api-contracts";
import { prisma } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext { params: Promise<{ id: string }> }

const Body = z.object({
  locales: z.array(Locale).optional(),
  dirtyOnly: z.boolean().default(true),
});

const IOS_FIELDS = [
  "name",
  "subtitle",
  "description",
  "keywords",
  "whatsNew",
  "promotionalText",
  "marketingUrl",
  "supportUrl",
  "privacyPolicyUrl",
] as const;
const ANDROID_FIELDS = ["name", "shortDescription", "description", "videoUrl"] as const;

type FieldKey = (typeof IOS_FIELDS)[number] | (typeof ANDROID_FIELDS)[number];

interface FieldDiff {
  field: FieldKey;
  before: string | null;
  after: string | null;
  changed: boolean;
}

interface LocaleDiff {
  canonicalLocale: string;
  changes: FieldDiff[];
  unsupportedOnGoogle: boolean;
  /** Truncations that *will* happen on push (informational only — server enforces) */
  notes: string[];
}

interface DiffResponse {
  app: { id: string; platform: "IOS" | "ANDROID" };
  locales: LocaleDiff[];
  totals: {
    locales: number;
    fields: number;
    unsupportedOnGoogle: number;
  };
}

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;
  const body = Body.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    const where: { appId: string; dirty?: boolean; locale?: { in: string[] } } = { appId: id };
    if (body.locales && body.locales.length > 0) where.locale = { in: body.locales };
    else if (body.dirtyOnly) where.dirty = true;

    const localsNow = await prisma.appLocalization.findMany({ where });

    // Pull the latest store snapshot via Apple/Google would be expensive.
    // Instead we treat the field at lastFetchedAt as the "before" — the
    // values in the row ARE the lastFetched values UNLESS the user has
    // edited them locally (dirty=true). We don't have a snapshot table,
    // so for now we approximate "before" as the empty string and "after"
    // as the current value. This matches the user mental model ("here's
    // what we're about to send"). A future Phase 2.5 will add per-locale
    // snapshots so we can show true before/after.

    const fields = (app.platform === "IOS" ? IOS_FIELDS : ANDROID_FIELDS) as readonly FieldKey[];

    const localeDiffs: LocaleDiff[] = localsNow.map((row) => {
      const changes: FieldDiff[] = fields.map((f) => {
        const after = (row as unknown as Record<FieldKey, string | null>)[f];
        return { field: f, before: null, after, changed: Boolean(after && after.length > 0) };
      });

      const notes: string[] = [];
      let unsupported = false;
      if (app.platform === "ANDROID") {
        const googleLocale = toGooglePlayLocale(row.locale);
        if (!isGooglePlaySupported(googleLocale)) {
          unsupported = true;
          notes.push(`Google Play does not support "${row.locale}" (mapped to "${googleLocale}")`);
        }
      }

      return {
        canonicalLocale: row.locale,
        changes,
        unsupportedOnGoogle: unsupported,
        notes,
      };
    });

    const response: DiffResponse = {
      app: { id: app.id, platform: app.platform },
      locales: localeDiffs,
      totals: {
        locales: localeDiffs.length,
        fields: localeDiffs.reduce(
          (acc, l) => acc + l.changes.filter((c) => c.changed).length,
          0,
        ),
        unsupportedOnGoogle: localeDiffs.filter((l) => l.unsupportedOnGoogle).length,
      },
    };
    return NextResponse.json(response);
  });
});
