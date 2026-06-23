import type { AppleClient } from "./AppleClient";

/**
 * Loose semver-descending comparator. "1.10.0" > "1.2.0" works correctly
 * (lexicographic comparison would invert these). Non-numeric segments
 * fall through to string compare so beta tags etc. don't crash sorting.
 */
function semverDesc(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number(p));
  const pb = b.split(".").map((p) => Number(p));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return b.localeCompare(a);
    if (ai !== bi) return bi - ai;
  }
  return 0;
}

export interface AppleAppSummary {
  storeAppId: string;
  bundleId: string;
  name: string;
  sku: string;
  primaryLocale: string;
}

interface JsonApiApp {
  id: string;
  type: "apps";
  attributes: {
    bundleId: string;
    name: string;
    sku: string;
    primaryLocale: string;
  };
}

interface JsonApiVersion {
  id: string;
  type: "appStoreVersions";
  attributes: {
    versionString: string;
    appStoreState: string;
    releaseType: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";
    earliestReleaseDate: string | null;
    copyright: string | null;
    platform: "IOS" | "MAC_OS" | "TV_OS";
    createdDate: string;
  };
}

export interface AppleAppFullDetails {
  storeAppId: string;
  bundleId: string;
  name: string;
  sku: string;
  primaryLocale: string;
  versionId: string | null;
  versionString: string | null;
  status: string | null;
  releaseType: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED" | null;
  earliestReleaseDate: string | null;
  copyright: string | null;
}

/**
 * Apps + AppStoreVersions lookup. Metadata localizations live in
 * AppleMetadata.ts so they can be invoked independently.
 */
export class AppleApps {
  constructor(private readonly client: AppleClient) {}

  async listApps(limit = 200): Promise<AppleAppSummary[]> {
    const out: AppleAppSummary[] = [];
    for await (const item of this.client.paginate<JsonApiApp>({
      path: "/apps",
      query: { limit, sort: "name" },
      pageLimit: 10,
    })) {
      out.push({
        storeAppId: item.id,
        bundleId: item.attributes.bundleId,
        name: item.attributes.name,
        sku: item.attributes.sku,
        primaryLocale: item.attributes.primaryLocale,
      });
    }
    return out;
  }

  async getApp(storeAppId: string): Promise<AppleAppSummary | null> {
    try {
      const res = await this.client.request<{ data: JsonApiApp }>({
        method: "GET",
        path: `/apps/${encodeURIComponent(storeAppId)}`,
      });
      return {
        storeAppId: res.data.id,
        bundleId: res.data.attributes.bundleId,
        name: res.data.attributes.name,
        sku: res.data.attributes.sku,
        primaryLocale: res.data.attributes.primaryLocale,
      };
    } catch {
      return null;
    }
  }

  async getLatestVersion(storeAppId: string): Promise<JsonApiVersion | null> {
    // Apple's /apps/{id}/appStoreVersions relationship endpoint does NOT
    // accept a `sort` parameter (returns PARAMETER_ERROR.ILLEGAL). We
    // fetch up to 20 versions and pick the one a publisher most likely
    // wants to READ from.
    //
    // Priority order — LIVE-first for "pull from store":
    //   1. READY_FOR_SALE             — what users currently see in the App Store
    //   2. PENDING_*                  — already approved, just waiting
    //   3. WAITING / IN_REVIEW        — submitted, queued
    //   4. PREPARE_FOR_SUBMISSION     — fresh draft; usually empty
    //   5. anything else
    //
    // Why LIVE-first: an app with a draft in PREPARE_FOR_SUBMISSION
    // usually has no metadata or screenshots yet. Pulling from the
    // draft returns count=0 and the user thinks the system is broken.
    // The live version is what they want to see + clone into a draft.
    const res = await this.client.request<{ data: JsonApiVersion[] }>({
      method: "GET",
      path: `/apps/${encodeURIComponent(storeAppId)}/appStoreVersions`,
      query: { limit: 20 },
    });
    if (res.data.length === 0) return null;

    const STATE_PRIORITY: Record<string, number> = {
      READY_FOR_SALE: 100,
      PENDING_DEVELOPER_RELEASE: 90,
      PENDING_APPLE_RELEASE: 85,
      PROCESSING_FOR_APP_STORE: 80,
      IN_REVIEW: 70,
      WAITING_FOR_REVIEW: 60,
      DEVELOPER_REMOVED_FROM_SALE: 50,
      DEVELOPER_REJECTED: 40,
      REJECTED: 35,
      METADATA_REJECTED: 30,
      PREPARE_FOR_SUBMISSION: 20,
    };
    function score(v: JsonApiVersion): number {
      return STATE_PRIORITY[v.attributes.appStoreState] ?? 0;
    }

    return [...res.data].sort((a, b) => {
      const ds = score(b) - score(a);
      if (ds !== 0) return ds;
      return semverDesc(a.attributes.versionString, b.attributes.versionString);
    })[0] ?? null;
  }

  async getFullDetails(storeAppId: string): Promise<AppleAppFullDetails | null> {
    const app = await this.getApp(storeAppId);
    if (!app) return null;
    const version = await this.getLatestVersion(storeAppId);
    return {
      ...app,
      versionId: version?.id ?? null,
      versionString: version?.attributes.versionString ?? null,
      status: version?.attributes.appStoreState ?? null,
      releaseType: version?.attributes.releaseType ?? null,
      earliestReleaseDate: version?.attributes.earliestReleaseDate ?? null,
      copyright: version?.attributes.copyright ?? null,
    };
  }

  /**
   * Editable-version states. Apple permits PATCH on these; everything
   * else (READY_FOR_SALE, PROCESSING_*, IN_REVIEW, …) is read-only.
   */
  private static readonly EDITABLE_STATES = new Set([
    "PREPARE_FOR_SUBMISSION",
    "DEVELOPER_REJECTED",
    "REJECTED",
    "METADATA_REJECTED",
    "INVALID_BINARY",
  ]);

  /**
   * Returns the version id we can WRITE to (metadata, screenshots,
   * previews). Mirrors the Unity reference flow:
   *
   *   1. List versions; if any is editable, return its id.
   *   2. Otherwise create a new PREPARE_FOR_SUBMISSION version with
   *      `versionString` = nextSemver(latestLiveVersion).
   *
   * This is the canonical "push target". Pulling (read) should continue
   * to use `getLatestVersion` which prefers LIVE.
   */
  async getOrCreateEditableVersion(
    storeAppId: string,
  ): Promise<{ id: string; versionString: string; created: boolean; state: string }> {
    const res = await this.client.request<{ data: JsonApiVersion[] }>({
      method: "GET",
      path: `/apps/${encodeURIComponent(storeAppId)}/appStoreVersions`,
      query: { limit: 20 },
    });
    const editable = res.data.filter((v) =>
      AppleApps.EDITABLE_STATES.has(v.attributes.appStoreState),
    );
    if (editable.length > 0) {
      const pick = editable.sort((a, b) =>
        semverDesc(a.attributes.versionString, b.attributes.versionString),
      )[0]!;
      return {
        id: pick.id,
        versionString: pick.attributes.versionString,
        created: false,
        state: pick.attributes.appStoreState,
      };
    }

    // No editable version — auto-create one whose versionString bumps the
    // patch of the live version. iOS doesn't allow re-using a previously
    // published versionString.
    const live = res.data.length > 0
      ? [...res.data].sort((a, b) =>
          semverDesc(a.attributes.versionString, b.attributes.versionString),
        )[0]
      : null;
    const nextVersion = bumpPatch(live?.attributes.versionString ?? "1.0.0");
    const created = await this.client.request<{ data: JsonApiVersion }>({
      method: "POST",
      path: `/appStoreVersions`,
      body: {
        data: {
          type: "appStoreVersions",
          attributes: {
            platform: "IOS",
            versionString: nextVersion,
            releaseType: "MANUAL",
          },
          relationships: {
            app: { data: { type: "apps", id: storeAppId } },
          },
        },
      },
    });
    return {
      id: created.data.id,
      versionString: created.data.attributes.versionString,
      created: true,
      state: created.data.attributes.appStoreState,
    };
  }
}

/**
 * Bumps the patch segment of a semver-ish string: `1.0.4` → `1.0.5`.
 * Pads to three segments if missing; falls back to appending `.1` for
 * non-conforming strings so we never write an invalid versionString.
 */
function bumpPatch(v: string): string {
  const parts = v.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) {
    return `${v}.1`;
  }
  while (parts.length < 3) parts.push(0);
  parts[parts.length - 1] = (parts[parts.length - 1] ?? 0) + 1;
  return parts.join(".");
}
