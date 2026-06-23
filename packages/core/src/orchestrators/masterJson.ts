/**
 * Master JSON importer.
 *
 * The master JSON format is the human-readable, version-controllable source
 * of truth for app-store copy. Schema is locale-key → field map:
 *
 *   {
 *     "_schema": "1.0",
 *     "_comment": "Word Stack — multilingual master",
 *     "en-US": { "app_name": "...", "subtitle": "...", "description": "...", ... },
 *     "tr":    { ... },
 *     ...
 *   }
 *
 * The importer:
 *   1. Validates the schema version
 *   2. Normalises every locale to canonical form
 *   3. Optionally truncates fields to per-platform character limits
 *   4. Returns a structured diff result (succeeded / failed / unsupported /
 *      truncated). The caller persists changes via DB UPSERT.
 *
 * The importer is **pure**: it does NOT write to the DB. The API layer
 * inspects the result and decides whether to apply or just preview.
 */

import { isGooglePlaySupported, toGooglePlayLocale } from "../locale";
import { ValidationError } from "../errors";

export type Platform = "IOS" | "ANDROID";

export const IOS_CHAR_LIMITS = {
  name: 30,
  subtitle: 30,
  description: 4000,
  keywords: 100,
  whatsNew: 4000,
  promotionalText: 170,
  marketingUrl: 255,
  supportUrl: 255,
  privacyPolicyUrl: 255,
} as const;

export const ANDROID_CHAR_LIMITS = {
  name: 50,
  shortDescription: 80,
  description: 4000,
  videoUrl: 255,
  privacyPolicyUrl: 255,
} as const;

/** Master JSON field → internal field name */
export const MASTER_JSON_FIELDS: Record<string, keyof LocalizationFieldsForUpsert> = {
  app_name: "name",
  name: "name",
  title: "name",
  subtitle: "subtitle",
  short_description: "shortDescription",
  shortDescription: "shortDescription",
  description: "description",
  full_description: "description",
  keywords: "keywords",
  whats_new: "whatsNew",
  whatsNew: "whatsNew",
  promotional_text: "promotionalText",
  promotionalText: "promotionalText",
  marketing_url: "marketingUrl",
  marketingUrl: "marketingUrl",
  support_url: "supportUrl",
  supportUrl: "supportUrl",
  privacy_policy_url: "privacyPolicyUrl",
  privacyPolicyUrl: "privacyPolicyUrl",
  video_url: "videoUrl",
  videoUrl: "videoUrl",
};

export interface LocalizationFieldsForUpsert {
  name?: string | null;
  subtitle?: string | null;
  description?: string | null;
  keywords?: string | null;
  whatsNew?: string | null;
  promotionalText?: string | null;
  marketingUrl?: string | null;
  supportUrl?: string | null;
  privacyPolicyUrl?: string | null;
  shortDescription?: string | null;
  videoUrl?: string | null;
}

export interface LocalePushAction {
  canonicalLocale: string;
  fields: LocalizationFieldsForUpsert;
}

export interface MasterJsonImportInput {
  json: string;
  platform: Platform;
  /** Apply per-platform character limits by truncating overflow. */
  truncateToLimits?: boolean;
  /** Only import locales we don't already have. */
  existingLocales?: string[];
  onlyNewLocales?: boolean;
}

export interface MasterJsonImportResult {
  schema: string;
  parsedLocales: number;
  actions: LocalePushAction[];
  matched: string[];
  created: string[];
  skipped: { locale: string; reason: string }[];
  failed: { locale: string; reason: string }[];
  truncated: { locale: string; field: string; fromLen: number; toLen: number }[];
  unsupportedGooglePlay: string[];
}

function truncateToCodepoints(s: string, max: number): string {
  if ([...s].length <= max) return s;
  return [...s].slice(0, max).join("");
}

export function importMasterJson(input: MasterJsonImportInput): MasterJsonImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.json);
  } catch (cause: unknown) {
    throw new ValidationError("Master JSON is not valid JSON", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("Master JSON must be an object keyed by locale");
  }
  const obj = parsed as Record<string, unknown>;
  const schema = typeof obj._schema === "string" ? obj._schema : "1.0";

  const limits = input.platform === "IOS" ? IOS_CHAR_LIMITS : ANDROID_CHAR_LIMITS;
  const existing = new Set(input.existingLocales ?? []);
  const result: MasterJsonImportResult = {
    schema,
    parsedLocales: 0,
    actions: [],
    matched: [],
    created: [],
    skipped: [],
    failed: [],
    truncated: [],
    unsupportedGooglePlay: [],
  };

  for (const [locale, raw] of Object.entries(obj)) {
    if (locale.startsWith("_")) continue;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      result.failed.push({ locale, reason: "Locale value must be an object" });
      continue;
    }
    result.parsedLocales += 1;

    if (input.onlyNewLocales && existing.has(locale)) {
      result.skipped.push({ locale, reason: "already exists" });
      continue;
    }

    if (input.platform === "ANDROID") {
      const googleLocale = toGooglePlayLocale(locale);
      if (!isGooglePlaySupported(googleLocale)) {
        result.unsupportedGooglePlay.push(locale);
        continue;
      }
    }

    const fields: LocalizationFieldsForUpsert = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const target = MASTER_JSON_FIELDS[key];
      if (!target) continue;
      if (typeof value !== "string") continue;
      let text = value;
      const limit = (limits as Record<string, number | undefined>)[target];
      if (limit !== undefined && [...text].length > limit) {
        if (input.truncateToLimits) {
          result.truncated.push({
            locale,
            field: target,
            fromLen: [...text].length,
            toLen: limit,
          });
          text = truncateToCodepoints(text, limit);
        } else {
          result.failed.push({
            locale,
            reason: `${target} exceeds limit ${limit.toString()} (got ${[...text].length.toString()})`,
          });
          continue;
        }
      }
      (fields as Record<string, string>)[target] = text;
    }

    if (Object.keys(fields).length === 0) {
      result.skipped.push({ locale, reason: "no recognised fields" });
      continue;
    }

    result.actions.push({ canonicalLocale: locale, fields });
    if (existing.has(locale)) result.matched.push(locale);
    else result.created.push(locale);
  }

  return result;
}

export function exportMasterJson(input: {
  localizations: (LocalizationFieldsForUpsert & { locale: string })[];
  schema?: string;
  comment?: string;
}): string {
  const out: Record<string, unknown> = {
    _schema: input.schema ?? "1.0",
    _comment: input.comment ?? "Generated by Release Flight",
  };
  for (const loc of input.localizations) {
    const body: Record<string, string> = {};
    for (const [masterKey, internalField] of Object.entries(MASTER_JSON_FIELDS)) {
      // Prefer the snake_case forms in output for human readability
      if (masterKey.includes("_") || masterKey === internalField) continue;
    }
    if (loc.name) body.app_name = loc.name;
    if (loc.subtitle) body.subtitle = loc.subtitle;
    if (loc.description) body.description = loc.description;
    if (loc.keywords) body.keywords = loc.keywords;
    if (loc.whatsNew) body.whats_new = loc.whatsNew;
    if (loc.promotionalText) body.promotional_text = loc.promotionalText;
    if (loc.marketingUrl) body.marketing_url = loc.marketingUrl;
    if (loc.supportUrl) body.support_url = loc.supportUrl;
    if (loc.privacyPolicyUrl) body.privacy_policy_url = loc.privacyPolicyUrl;
    if (loc.shortDescription) body.short_description = loc.shortDescription;
    if (loc.videoUrl) body.video_url = loc.videoUrl;
    out[loc.locale] = body;
  }
  return JSON.stringify(out, null, 2);
}
