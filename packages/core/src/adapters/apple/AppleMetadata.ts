import { ConflictError } from "../../errors";
import { toAppleLocale } from "../../locale";
import type { AppleClient } from "./AppleClient";

// ───────────────────────────────────────────────────────────────────────
// JSON:API shapes
// ───────────────────────────────────────────────────────────────────────

interface JsonApiAppInfo {
  id: string;
  type: "appInfos";
  attributes: { appStoreState: string };
}

interface JsonApiAppInfoLocalization {
  id: string;
  type: "appInfoLocalizations";
  attributes: {
    locale: string;
    name: string | null;
    subtitle: string | null;
    privacyPolicyUrl: string | null;
  };
}

interface JsonApiVersionLocalization {
  id: string;
  type: "appStoreVersionLocalizations";
  attributes: {
    locale: string;
    description: string | null;
    keywords: string | null;
    whatsNew: string | null;
    promotionalText: string | null;
    marketingUrl: string | null;
    supportUrl: string | null;
  };
}

interface JsonApiAppStoreVersion {
  id: string;
  type: "appStoreVersions";
  attributes: {
    appStoreState: string;
    versionString: string;
  };
}

// ───────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────

export interface AppleAppInfoLocalization {
  id: string;
  locale: string;
  name: string | null;
  subtitle: string | null;
  privacyPolicyUrl: string | null;
}

export interface AppleVersionLocalization {
  id: string;
  locale: string;
  description: string | null;
  keywords: string | null;
  whatsNew: string | null;
  promotionalText: string | null;
  marketingUrl: string | null;
  supportUrl: string | null;
}

export interface AppleMergedLocalization {
  locale: string;
  appInfoLocalizationId: string | null;
  versionLocalizationId: string | null;
  name: string | null;
  subtitle: string | null;
  privacyPolicyUrl: string | null;
  description: string | null;
  keywords: string | null;
  whatsNew: string | null;
  promotionalText: string | null;
  marketingUrl: string | null;
  supportUrl: string | null;
}

export interface UpsertLocalizationFields {
  name?: string | null;
  subtitle?: string | null;
  privacyPolicyUrl?: string | null;
  description?: string | null;
  keywords?: string | null;
  whatsNew?: string | null;
  promotionalText?: string | null;
  marketingUrl?: string | null;
  supportUrl?: string | null;
}

type FieldOutcome =
  | { action: "skipped"; reason: string }
  | { action: "created"; id: string; reason?: string }
  | { action: "updated"; id: string; reason?: string }
  | { action: "failed"; reason: string };

export interface UpsertLocalizationResult {
  locale: string;
  appleLocale: string;
  versionLocalization: FieldOutcome;
  appInfoLocalization: FieldOutcome;
}

// Apple state codes that allow editing version-localization fields
const EDITABLE_VERSION_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "WAITING_FOR_REVIEW",
  "INVALID_BINARY",
]);

// Editable app-info state codes
const EDITABLE_APP_INFO_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
]);

function hasVersionFields(f: UpsertLocalizationFields): boolean {
  return (
    f.description !== undefined ||
    f.keywords !== undefined ||
    f.whatsNew !== undefined ||
    f.promotionalText !== undefined ||
    f.marketingUrl !== undefined ||
    f.supportUrl !== undefined
  );
}

function hasAppInfoFields(f: UpsertLocalizationFields): boolean {
  return f.name !== undefined || f.subtitle !== undefined || f.privacyPolicyUrl !== undefined;
}

/**
 * Apple App Store Connect metadata adapter.
 *
 * Apple keeps metadata in TWO places:
 *   • AppInfoLocalization     → name, subtitle, privacyPolicyUrl  (app-level)
 *   • AppStoreVersionLoc.     → description, keywords, whatsNew,
 *                                promotionalText, marketing/support URL
 *
 * This adapter:
 *   1. Fetches both with a paginated iterator (max 50 pages per call)
 *   2. Merges them per-locale so the caller sees a single record
 *   3. Provides upsert that branches into 4 sub-flows (create/update for
 *      both groups) and gracefully skips 409 conflicts on state-locked
 *      fields.
 */
export class AppleMetadata {
  constructor(private readonly client: AppleClient) {}

  async fetchAppInfoLocalizations(
    storeAppId: string,
  ): Promise<Map<string, AppleAppInfoLocalization>> {
    const infos = await this.client.request<{ data: JsonApiAppInfo[] }>({
      method: "GET",
      path: `/apps/${encodeURIComponent(storeAppId)}/appInfos`,
      query: { limit: 1 },
    });
    const appInfo = infos.data[0];
    if (!appInfo) return new Map();

    const out = new Map<string, AppleAppInfoLocalization>();
    for await (const loc of this.client.paginate<JsonApiAppInfoLocalization>({
      path: `/appInfos/${encodeURIComponent(appInfo.id)}/appInfoLocalizations`,
      query: { limit: 50 },
      pageLimit: 50,
    })) {
      out.set(loc.attributes.locale, {
        id: loc.id,
        locale: loc.attributes.locale,
        name: loc.attributes.name,
        subtitle: loc.attributes.subtitle,
        privacyPolicyUrl: loc.attributes.privacyPolicyUrl,
      });
    }
    return out;
  }

  async fetchVersionLocalizations(
    versionId: string,
  ): Promise<Map<string, AppleVersionLocalization>> {
    const out = new Map<string, AppleVersionLocalization>();
    for await (const loc of this.client.paginate<JsonApiVersionLocalization>({
      path: `/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`,
      query: { limit: 50 },
      pageLimit: 50,
    })) {
      out.set(loc.attributes.locale, {
        id: loc.id,
        locale: loc.attributes.locale,
        description: loc.attributes.description,
        keywords: loc.attributes.keywords,
        whatsNew: loc.attributes.whatsNew,
        promotionalText: loc.attributes.promotionalText,
        marketingUrl: loc.attributes.marketingUrl,
        supportUrl: loc.attributes.supportUrl,
      });
    }
    return out;
  }

  mergeLocalizations(
    appInfo: Map<string, AppleAppInfoLocalization>,
    version: Map<string, AppleVersionLocalization>,
  ): AppleMergedLocalization[] {
    const locales = new Set<string>([...appInfo.keys(), ...version.keys()]);
    return [...locales].map((locale) => {
      const ai = appInfo.get(locale);
      const vl = version.get(locale);
      return {
        locale,
        appInfoLocalizationId: ai?.id ?? null,
        versionLocalizationId: vl?.id ?? null,
        name: ai?.name ?? null,
        subtitle: ai?.subtitle ?? null,
        privacyPolicyUrl: ai?.privacyPolicyUrl ?? null,
        description: vl?.description ?? null,
        keywords: vl?.keywords ?? null,
        whatsNew: vl?.whatsNew ?? null,
        promotionalText: vl?.promotionalText ?? null,
        marketingUrl: vl?.marketingUrl ?? null,
        supportUrl: vl?.supportUrl ?? null,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Push
  // ─────────────────────────────────────────────────────────────────

  async upsertLocalization(input: {
    storeAppId: string;
    versionId: string | null;
    canonicalLocale: string;
    fields: UpsertLocalizationFields;
  }): Promise<UpsertLocalizationResult> {
    const appleLocale = toAppleLocale(input.canonicalLocale);
    const result: UpsertLocalizationResult = {
      locale: input.canonicalLocale,
      appleLocale,
      versionLocalization: { action: "skipped", reason: "no fields" },
      appInfoLocalization: { action: "skipped", reason: "no fields" },
    };

    // ─── Part A: version localization ───
    if (hasVersionFields(input.fields) && input.versionId) {
      const versionState = await this.getVersionState(input.versionId);
      if (versionState && !EDITABLE_VERSION_STATES.has(versionState)) {
        result.versionLocalization = {
          action: "skipped",
          reason: `version state ${versionState} is not editable`,
        };
      } else {
        result.versionLocalization = await this.upsertVersionLocalization(
          input.versionId,
          appleLocale,
          input.fields,
        );
      }
    }

    // ─── Part B: app-info localization ───
    if (hasAppInfoFields(input.fields)) {
      const appInfo = await this.getAppInfo(input.storeAppId);
      if (!appInfo) {
        result.appInfoLocalization = { action: "skipped", reason: "no appInfo" };
      } else if (!EDITABLE_APP_INFO_STATES.has(appInfo.state)) {
        result.appInfoLocalization = {
          action: "skipped",
          reason: `app-info state ${appInfo.state} is not editable`,
        };
      } else {
        result.appInfoLocalization = await this.upsertAppInfoLocalization(
          appInfo.id,
          appleLocale,
          input.fields,
        );
      }
    }

    return result;
  }

  async updateVersionSettings(input: {
    versionId: string;
    versionString?: string;
    releaseType?: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";
    earliestReleaseDate?: string | null;
    copyright?: string;
  }): Promise<void> {
    const attributes: Record<string, unknown> = {};
    if (input.versionString) attributes.versionString = input.versionString;
    if (input.releaseType) attributes.releaseType = input.releaseType;
    if (input.releaseType === "SCHEDULED" && input.earliestReleaseDate) {
      attributes.earliestReleaseDate = input.earliestReleaseDate;
    }
    if (input.copyright !== undefined) attributes.copyright = input.copyright;
    if (Object.keys(attributes).length === 0) return;
    await this.client.request({
      method: "PATCH",
      path: `/appStoreVersions/${encodeURIComponent(input.versionId)}`,
      body: {
        data: { type: "appStoreVersions", id: input.versionId, attributes },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────

  private async getVersionState(versionId: string): Promise<string | null> {
    try {
      const res = await this.client.request<{ data: JsonApiAppStoreVersion }>({
        method: "GET",
        path: `/appStoreVersions/${encodeURIComponent(versionId)}`,
      });
      return res.data.attributes.appStoreState;
    } catch {
      return null;
    }
  }

  private async getAppInfo(storeAppId: string): Promise<{ id: string; state: string } | null> {
    const res = await this.client.request<{ data: JsonApiAppInfo[] }>({
      method: "GET",
      path: `/apps/${encodeURIComponent(storeAppId)}/appInfos`,
      query: { limit: 1 },
    });
    const info = res.data[0];
    return info ? { id: info.id, state: info.attributes.appStoreState } : null;
  }

  private async upsertVersionLocalization(
    versionId: string,
    appleLocale: string,
    fields: UpsertLocalizationFields,
  ): Promise<FieldOutcome> {
    const existing = await this.findVersionLocalization(versionId, appleLocale);
    const attributes = this.versionAttributes(fields);
    if (Object.keys(attributes).length === 0 && !existing) {
      return { action: "skipped", reason: "no fields" };
    }
    return this.patchOrCreateWithSelfHealing({
      attributes,
      existing,
      appleLocale,
      patchPath: (id) => `/appStoreVersionLocalizations/${encodeURIComponent(id)}`,
      postPath: "/appStoreVersionLocalizations",
      type: "appStoreVersionLocalizations",
      createRelationships: {
        appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
      },
    });
  }

  /**
   * PATCH (or POST) the attributes, with self-healing retries when Apple
   * rejects a specific attribute. Two common cases this absorbs:
   *
   *   • "Attribute 'whatsNew' cannot be edited at this time" — Apple
   *     forbids whatsNew on first-time submissions. We drop the
   *     offending attribute and retry the rest.
   *   • "Attribute 'X' is invalid…" — same recovery; surface a clear
   *     reason if we can't progress at all.
   *
   * Up to 3 retries (one per attribute Apple complains about). The
   * returned `reason` lists the dropped fields so the user knows what
   * they need to fix on the App Store side.
   */
  private async patchOrCreateWithSelfHealing(input: {
    attributes: Record<string, string | null>;
    existing: { id: string } | null;
    appleLocale: string;
    patchPath: (id: string) => string;
    postPath: string;
    type: string;
    createRelationships?: Record<string, unknown>;
  }): Promise<FieldOutcome> {
    const attrs = { ...input.attributes };
    const dropped: { field: string; reason: string }[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        if (input.existing) {
          await this.client.request({
            method: "PATCH",
            path: input.patchPath(input.existing.id),
            body: {
              data: { type: input.type, id: input.existing.id, attributes: attrs },
            },
          });
          if (dropped.length === 0) {
            return { action: "updated", id: input.existing.id };
          }
          return {
            action: "updated",
            id: input.existing.id,
            reason: `partial — Apple rejected ${dropped.map((d) => `'${d.field}' (${d.reason})`).join(", ")}`,
          };
        }
        const res = await this.client.request<{ data: { id: string } }>({
          method: "POST",
          path: input.postPath,
          body: {
            data: {
              type: input.type,
              attributes: { locale: input.appleLocale, ...attrs },
              ...(input.createRelationships ? { relationships: input.createRelationships } : {}),
            },
          },
        });
        if (dropped.length === 0) return { action: "created", id: res.data.id };
        return {
          action: "created",
          id: res.data.id,
          reason: `partial — Apple rejected ${dropped.map((d) => `'${d.field}'`).join(", ")}`,
        };
      } catch (err: unknown) {
        const offending = extractOffendingAttribute(err);
        if (offending && offending in attrs) {
          dropped.push({ field: offending, reason: extractReasonShort(err) });
          delete attrs[offending];
          if (Object.keys(attrs).length === 0) {
            return {
              action: "skipped",
              reason: `every field rejected: ${dropped.map((d) => `'${d.field}'`).join(", ")}`,
            };
          }
          continue;
        }
        if (err instanceof ConflictError) {
          return { action: "skipped", reason: `conflict: ${err.message}` };
        }
        return {
          action: "failed",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { action: "skipped", reason: "too many retries" };
  }

  private async upsertAppInfoLocalization(
    appInfoId: string,
    appleLocale: string,
    fields: UpsertLocalizationFields,
  ): Promise<FieldOutcome> {
    const existing = await this.findAppInfoLocalization(appInfoId, appleLocale);
    const attributes = this.appInfoAttributes(fields);
    if (Object.keys(attributes).length === 0 && !existing) {
      return { action: "skipped", reason: "no fields" };
    }
    return this.patchOrCreateWithSelfHealing({
      attributes,
      existing,
      appleLocale,
      patchPath: (id) => `/appInfoLocalizations/${encodeURIComponent(id)}`,
      postPath: "/appInfoLocalizations",
      type: "appInfoLocalizations",
      createRelationships: { appInfo: { data: { type: "appInfos", id: appInfoId } } },
    });
  }

  private async findVersionLocalization(
    versionId: string,
    appleLocale: string,
  ): Promise<{ id: string } | null> {
    const res = await this.client.request<{ data: JsonApiVersionLocalization[] }>({
      method: "GET",
      path: `/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`,
      query: { "filter[locale]": appleLocale, limit: 1 },
    });
    return res.data[0] ? { id: res.data[0].id } : null;
  }

  private async findAppInfoLocalization(
    appInfoId: string,
    appleLocale: string,
  ): Promise<{ id: string } | null> {
    const res = await this.client.request<{ data: JsonApiAppInfoLocalization[] }>({
      method: "GET",
      path: `/appInfos/${encodeURIComponent(appInfoId)}/appInfoLocalizations`,
      query: { "filter[locale]": appleLocale, limit: 1 },
    });
    return res.data[0] ? { id: res.data[0].id } : null;
  }

  /**
   * Apple App Store Connect rejects empty strings on URL fields with
   * "must be a valid RFC 3986 URI" and rejects empty strings on most
   * text fields with cryptic 409 conflicts. We normalise:
   *   • undefined → key omitted (Apple keeps the existing value)
   *   • null / "" / whitespace → null (Apple clears the field)
   *   • non-empty trimmed string → that string
   * URL fields additionally pass through `isHttpUrl()`; anything that
   * isn't a real http(s) URI is treated as "clear it" rather than risk
   * a rejection that aborts the whole push.
   */
  private versionAttributes(fields: UpsertLocalizationFields): Record<string, string | null> {
    const a: Record<string, string | null> = {};
    if (fields.description !== undefined) a.description = nullifyText(fields.description);
    if (fields.keywords !== undefined) a.keywords = nullifyText(fields.keywords);
    if (fields.whatsNew !== undefined) a.whatsNew = nullifyText(fields.whatsNew);
    if (fields.promotionalText !== undefined)
      a.promotionalText = nullifyText(fields.promotionalText);
    if (fields.marketingUrl !== undefined) a.marketingUrl = nullifyUrl(fields.marketingUrl);
    if (fields.supportUrl !== undefined) a.supportUrl = nullifyUrl(fields.supportUrl);
    return a;
  }

  private appInfoAttributes(fields: UpsertLocalizationFields): Record<string, string | null> {
    const a: Record<string, string | null> = {};
    if (fields.name !== undefined) a.name = nullifyText(fields.name);
    if (fields.subtitle !== undefined) a.subtitle = nullifyText(fields.subtitle);
    if (fields.privacyPolicyUrl !== undefined)
      a.privacyPolicyUrl = nullifyUrl(fields.privacyPolicyUrl);
    return a;
  }
}

/** Trim + treat empty / whitespace-only as null. */
function nullifyText(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** Trim, require http(s) scheme + valid URL parse; anything else → null. */
function nullifyUrl(v: string | null | undefined): string | null {
  const t = nullifyText(v);
  if (!t) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Inspect an Apple API error for a JSON:API `source.pointer` of
 * `/data/attributes/<field>` and return the field name. Apple uses two
 * shapes; we try both.
 */
function extractOffendingAttribute(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  // 1. JSON:API source.pointer surfaced through our UpstreamError wrapper.
  // The wrapper attaches the raw payload on `.cause` or stringifies it.
  interface AppleErr {
    source?: { pointer?: string };
  }
  const cause = (err as Error & { cause?: unknown }).cause;
  const errors =
    cause && typeof cause === "object" && "errors" in cause
      ? (cause as { errors: AppleErr[] }).errors
      : null;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      const ptr = e?.source?.pointer;
      if (typeof ptr === "string") {
        const m = /\/data\/attributes\/([A-Za-z0-9_]+)/.exec(ptr);
        if (m?.[1]) return m[1];
      }
    }
  }
  // 2. Fall back to message scraping — Apple's error messages contain
  // the attribute name in quotes (e.g. "Attribute 'whatsNew' cannot be
  // edited at this time").
  const msg = err.message ?? "";
  const m =
    /Attribute '([A-Za-z0-9_]+)'/.exec(msg) ||
    /attribute named '([A-Za-z0-9_]+)'/.exec(msg) ||
    /'([A-Za-z0-9_]+)' is invalid/.exec(msg) ||
    /'([A-Za-z0-9_]+)' can not be modified/.exec(msg);
  return m?.[1] ?? null;
}

/** Short reason ("cannot be edited", "invalid", …) for the user-facing log. */
function extractReasonShort(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/cannot be edited at this time/i.test(msg)) return "locked at this app-store stage";
  if (/can not be modified/i.test(msg)) return "not modifiable";
  if (/invalid/i.test(msg)) return "invalid value";
  if (/must be a valid/i.test(msg)) return "format invalid";
  return msg.slice(0, 80);
}
