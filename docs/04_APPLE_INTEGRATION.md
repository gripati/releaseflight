# 04 — Apple App Store Connect Integration

Bu doküman, **mevcut `AppStoreConnectAPI.cs` (3000 satır) + `JWTHelper.cs` + `MetadataManager.cs` + `ScreenshotManager.cs` + `AppPreviewManager.cs`** dosyalarındaki Apple iletişim mantığının Web App'e bire bir taşıma şartnamesidir. Hedef paket: `packages/core/src/adapters/apple/`.

## 4.0 Referanslar

- App Store Connect API: https://developer.apple.com/documentation/appstoreconnectapi
- JSON:API spec: https://jsonapi.org/
- Apple "Uploading Assets to App Store Connect" guide (reserve + chunk + commit)

## 4.1 Modüller ve Dosya Yapısı

```
packages/core/src/adapters/apple/
├── AppleClient.ts                    # Düşük seviyeli HTTP wrapper
├── AppleAuth.ts                      # ES256 JWT üretimi + cache
├── AppleApps.ts                      # GetAllApps, GetApp, GetFullDetails
├── AppleMetadata.ts                  # Localizations + version settings
├── AppleScreenshots.ts               # 3-step upload + reorder + delete
├── AppleAppPreviews.ts               # Video upload (3-step, MIME-aware)
├── AppleBuilds.ts                    # List builds, submit for review
├── AppleErrors.ts                    # Error classification
├── AppleLocale.ts                    # AppleLocaleHelper port
├── types/
│   ├── jsonapi.ts                    # Apple JSON:API tipler
│   ├── app.ts
│   ├── localization.ts
│   ├── screenshot.ts
│   ├── preview.ts
│   └── build.ts
└── __tests__/
    ├── fixtures/                     # Gerçek Apple response sample'ları (redacted)
    └── *.test.ts
```

## 4.2 Authentication — `AppleAuth.ts`

### 4.2.1 ES256 JWT Üretimi

Mevcut Unity kodu `openssl` subprocess kullanıyor (`JWTHelper.cs:71-104`). Web tarafında **native Node crypto** yeterli:

```ts
import { createSign, KeyObject, createPrivateKey } from "node:crypto";

export interface AppleCredentialMaterial {
  keyId: string;        // "ABC123DEF4"
  issuerId: string;     // "57246542-96fe-1a63-e053-0824d011072a"
  privateKeyPem: string; // -----BEGIN PRIVATE KEY----- ... (PKCS#8 EC)
}

export class AppleAuth {
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  async getToken(cred: AppleCredentialMaterial): Promise<string> {
    const cacheKey = `${cred.keyId}:${cred.issuerId}`;
    const cached = this.tokenCache.get(cacheKey);
    // 5 dakika önce yenile (Apple 20 dk verir, biz 15 dk kullanırız)
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }
    const token = await this.createJWT(cred);
    this.tokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + 15 * 60 * 1000, // 15 dk
    });
    return token;
  }

  private async createJWT(cred: AppleCredentialMaterial): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: "ES256",
      kid: cred.keyId,
      typ: "JWT",
    };
    const payload = {
      iss: cred.issuerId,
      iat: now,
      exp: now + 1200,          // 20 dakika (Apple max)
      aud: "appstoreconnect-v1",
    };
    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const keyObject = createPrivateKey({ key: cred.privateKeyPem, format: "pem" });
    if (keyObject.asymmetricKeyType !== "ec") {
      throw new AppleAuthError("CREDENTIAL_INVALID", "Private key is not EC (ES256)");
    }
    const signer = createSign("SHA256");
    signer.update(signingInput);
    signer.end();
    // dsaEncoding: 'ieee-p1363' → 64 byte raw R||S (Apple gerektiği format)
    const signature = signer.sign({ key: keyObject, dsaEncoding: "ieee-p1363" });
    const signatureB64 = base64UrlEncode(signature);
    return `${signingInput}.${signatureB64}`;
  }
}
```

> **DİKKAT — `dsaEncoding: 'ieee-p1363'`** — Mevcut C# kodu DER signature'ı manuel olarak R||S'ye dönüştürüyor (`JWTHelper.cs:94`). Node.js'te `dsaEncoding` parametresi bunu otomatik yapar. **Bu detay atlanırsa Apple "Invalid token" döner.**

### 4.2.2 Token Cache Stratejisi

| Layer | TTL | Trigger |
|-------|-----|---------|
| Process memory (Map) | 15 dakika | Aynı process aynı cred için tekrar token üretmesin |
| Redis (`apple:token:<credId>`) | 14 dakika | Multi-worker setup'ta paylaşılan cache |
| Refresh strategy | 5 dakika kala (`expiresAt - now < 5min`) | Token expire ederken request fail olmasın |

```ts
async getTokenWithRedisCache(cred): Promise<string> {
  const key = `apple:token:${cred.id}`;
  const cached = await redis.get(key);
  if (cached) return cached;
  const token = await this.createJWT(cred);
  await redis.set(key, token, "PX", 14 * 60 * 1000);
  return token;
}
```

### 4.2.3 Test Bağlantısı

```ts
async testConnection(cred: AppleCredentialMaterial): Promise<{ ok: boolean; message: string }> {
  try {
    const token = await this.createJWT(cred);
    const res = await fetch("https://api.appstoreconnect.apple.com/v1/apps?limit=1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { ok: true, message: "Connected" };
    const body = await res.json();
    return { ok: false, message: parseAppleError(body) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
```

## 4.3 HTTP Layer — `AppleClient.ts`

```ts
const BASE_URL = "https://api.appstoreconnect.apple.com/v1";

export class AppleClient {
  constructor(private auth: AppleAuth, private cred: AppleCredentialMaterial) {}

  async request<T>(opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<T> {
    const token = await this.auth.getToken(this.cred);
    const url = new URL(BASE_URL + opts.path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000);
    if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort());

    try {
      const res = await fetch(url.toString(), {
        method: opts.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      if (res.status === 204) return undefined as T;
      const json = await res.json();
      if (!res.ok) throw classifyAppleError(res.status, json);
      return json as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Paginated GET — Apple cursor (links.next)
  async *paginate<T>(opts: { path: string; query?: Record<string, string | number | undefined>; pageLimit?: number }): AsyncIterableIterator<T> {
    let url: string | undefined = opts.path;
    let pageCount = 0;
    const max = opts.pageLimit ?? 50;
    while (url && pageCount < max) {
      const page = await this.request<{ data: T[]; links: { next?: string } }>({
        method: "GET",
        path: url,
        query: pageCount === 0 ? opts.query : undefined, // sonraki link tam URL
      });
      for (const item of page.data) yield item;
      url = page.links?.next?.replace(BASE_URL, "");
      pageCount++;
    }
  }
}
```

> **Query escape — `Q(value)` C# helper** (`AppStoreConnectAPI.cs:33`): URL search params otomatik escape ediyor; `URL.searchParams.set` aynısını yapar.

> **Path segment escape — `P(value)`** (`AppStoreConnectAPI.cs:37`): App ID gibi path segment'lerde de encode gerek; URL constructor halletmiyor (slashleri preserve etmek için), template literal kullanırken **`encodeURIComponent(appId)`** uygula.

## 4.4 Apps — `AppleApps.ts`

### 4.4.1 List Apps

C# karşılığı: `AppStoreConnectAPI.cs:122-249` `GetAllAppsAsync()`.

```ts
export interface AppleAppSummary {
  storeAppId: string;
  bundleId: string;
  name: string;
  sku: string;
  primaryLocale: string;
}

async listApps(): Promise<AppleAppSummary[]> {
  const out: AppleAppSummary[] = [];
  for await (const item of this.client.paginate<JsonApiApp>({ path: "/apps", query: { limit: 200 } })) {
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
```

### 4.4.2 Get Full Details

C# karşılığı: `GetAppFullDetailsAsync()` (line 255-332). Bu metod **iç içe iki paginated çağrı** yapar — `AppInfoLocalization` + `AppStoreVersionLocalization` — sonra **per-locale merge** eder.

```ts
async getFullDetails(storeAppId: string): Promise<AppleAppFullDetails> {
  // 1) App temel bilgileri
  const app = await this.client.request<{ data: JsonApiApp }>({
    method: "GET",
    path: `/apps/${encodeURIComponent(storeAppId)}`,
  });

  // 2) App-info localizations (name, subtitle, privacyPolicyUrl)
  const appInfoLocs = await this.metadata.fetchAppInfoLocalizations(storeAppId);
  // Map<locale, { id, name, subtitle, privacyPolicyUrl }>

  // 3) En son version
  const versions = await this.client.request<{ data: JsonApiVersion[] }>({
    method: "GET",
    path: `/apps/${encodeURIComponent(storeAppId)}/appStoreVersions`,
    query: { limit: 1, "sort": "-createdDate" },
  });
  const latestVersion = versions.data[0];
  if (!latestVersion) {
    // App'in version'ı yok, sadece app-level data dön
    return { ...mapAppData(app.data), versionId: null, localizations: [...appInfoLocs.values()].map(toCommonLocalization) };
  }

  // 4) Version localizations (description, keywords, whatsNew, promotionalText, marketing/support URL)
  const versionLocs = await this.metadata.fetchVersionLocalizations(latestVersion.id);

  // 5) MERGE — locale key'i üzerinden birleştir
  const merged = mergeLocalizations(appInfoLocs, versionLocs);

  return {
    storeAppId: app.data.id,
    versionId: latestVersion.id,
    name: app.data.attributes.name,
    bundleId: app.data.attributes.bundleId,
    sku: app.data.attributes.sku,
    primaryLocale: app.data.attributes.primaryLocale,
    version: latestVersion.attributes.versionString,
    status: latestVersion.attributes.appStoreState,
    releaseType: latestVersion.attributes.releaseType,
    earliestReleaseDate: latestVersion.attributes.earliestReleaseDate,
    copyright: latestVersion.attributes.copyright,
    localizations: merged,
    availableLanguages: [...merged.keys()],
  };
}
```

## 4.5 Metadata Pull — `AppleMetadata.ts`

### 4.5.1 App-Info Localizations

C# kaynak: `GetAppInfoLocalizationsAsync()` (line 337-420).

**Flow:**
1. `GET /apps/{appId}/appInfos?limit=1` → ilk appInfoId
2. Paginated: `GET /appInfos/{appInfoId}/appInfoLocalizations?limit=50`
3. Map'e topla (lokal key → object)

```ts
async fetchAppInfoLocalizations(storeAppId: string): Promise<Map<string, AppleAppInfoLocalization>> {
  // Step 1: get appInfoId
  const appInfosRes = await this.client.request<{ data: JsonApiAppInfo[] }>({
    method: "GET",
    path: `/apps/${encodeURIComponent(storeAppId)}/appInfos`,
    query: { limit: 1 },
  });
  const appInfo = appInfosRes.data[0];
  if (!appInfo) return new Map();

  // Step 2: paginated localizations
  const out = new Map<string, AppleAppInfoLocalization>();
  for await (const loc of this.client.paginate<JsonApiAppInfoLocalization>({
    path: `/appInfos/${encodeURIComponent(appInfo.id)}/appInfoLocalizations`,
    query: { limit: 50 },
    pageLimit: 50,    // hard cap
  })) {
    out.set(loc.attributes.locale, {
      id: loc.id,
      locale: loc.attributes.locale,
      name: loc.attributes.name ?? null,
      subtitle: loc.attributes.subtitle ?? null,
      privacyPolicyUrl: loc.attributes.privacyPolicyUrl ?? null,
    });
  }
  return out;
}
```

### 4.5.2 Version Localizations

C# kaynak: `FetchAllVersionLocalizationsAsync()` (line 426-508).

```ts
async fetchVersionLocalizations(versionId: string): Promise<Map<string, AppleVersionLocalization>> {
  const out = new Map<string, AppleVersionLocalization>();
  for await (const loc of this.client.paginate<JsonApiVersionLocalization>({
    path: `/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`,
    query: { limit: 50 },
    pageLimit: 50,
  })) {
    out.set(loc.attributes.locale, {
      id: loc.id,
      locale: loc.attributes.locale,
      description: loc.attributes.description ?? null,
      keywords: loc.attributes.keywords ?? null,
      whatsNew: loc.attributes.whatsNew ?? null,
      promotionalText: loc.attributes.promotionalText ?? null,
      marketingUrl: loc.attributes.marketingUrl ?? null,
      supportUrl: loc.attributes.supportUrl ?? null,
    });
  }
  return out;
}
```

### 4.5.3 Merge Stratejisi

Apple'da `AppInfoLocalization` (app-level) ve `AppStoreVersionLocalization` (version-level) **AYRI kayıtlardır**. Aynı locale için ikisini birleştirip kullanıcıya **tek bir localization** olarak gösteriyoruz.

```ts
function mergeLocalizations(
  appInfo: Map<string, AppleAppInfoLocalization>,
  version: Map<string, AppleVersionLocalization>
): Map<string, CommonLocalization> {
  const out = new Map<string, CommonLocalization>();
  const allLocales = new Set([...appInfo.keys(), ...version.keys()]);
  for (const locale of allLocales) {
    const ai = appInfo.get(locale);
    const vl = version.get(locale);
    out.set(locale, {
      locale,
      // app-info'dan
      appInfoLocalizationId: ai?.id ?? null,
      name: ai?.name ?? null,
      subtitle: ai?.subtitle ?? null,
      privacyPolicyUrl: ai?.privacyPolicyUrl ?? null,
      // version'dan
      versionLocalizationId: vl?.id ?? null,
      description: vl?.description ?? null,
      keywords: vl?.keywords ?? null,
      whatsNew: vl?.whatsNew ?? null,
      promotionalText: vl?.promotionalText ?? null,
      marketingUrl: vl?.marketingUrl ?? null,
      supportUrl: vl?.supportUrl ?? null,
    });
  }
  return out;
}
```

## 4.6 Metadata Push — `AppleMetadata.ts` (devam)

### 4.6.1 Tek Locale Push

C# kaynak: `UpdateMetadataAsync()` (line 514-989). Bu **EN KARMAŞIK** metot — 8 alt-akış var.

**Yüksek seviye akış:**

```
1. AppleLocaleHelper.normalize(locale) → "tr-TR" → "tr"
2. Get latest version (state check)
3. Eğer state editable değilse → CreateNewVersion() (auto-bump)
4. PART A: Version Localization (description, keywords, whatsNew, etc.)
   a. Filter: GET /appStoreVersions/{vid}/appStoreVersionLocalizations?filter[locale]={X}
   b. Yoksa: POST /appStoreVersionLocalizations → CREATE
   c. Varsa: PATCH /appStoreVersionLocalizations/{id} → UPDATE
   d. 409 gracefully skip (state locked field)
5. PART B: App-Info Localization (name, subtitle, privacyPolicyUrl)
   a. Get appInfoId
   b. Filter: GET /appInfos/{aid}/appInfoLocalizations?filter[locale]={X}
   c. Yoksa: POST → CREATE
   d. Varsa: PATCH → UPDATE
   e. 409 gracefully skip
6. Per-field başarı/başarısızlık raporla
```

**TypeScript implementasyon:**

```ts
export interface UpsertLocalizationInput {
  storeAppId: string;
  versionId: string | null;     // null ise tek-version-arama yap
  canonicalLocale: string;       // master JSON format
  fields: {
    name?: string | null;
    subtitle?: string | null;
    description?: string | null;
    keywords?: string | null;
    whatsNew?: string | null;
    promotionalText?: string | null;
    marketingUrl?: string | null;
    supportUrl?: string | null;
    privacyPolicyUrl?: string | null;
  };
}

async upsertLocalization(input: UpsertLocalizationInput): Promise<UpsertResult> {
  // 1. Locale normalize
  const appleLocale = appleLocaleHelper.toApple(input.canonicalLocale);

  // 2. Version state check + auto-create
  let versionId = input.versionId;
  if (!versionId) {
    const v = await this.findLatestVersion(input.storeAppId);
    versionId = v.id;
  }
  const state = await this.getVersionState(versionId);
  if (!isEditableState(state)) {
    versionId = await this.createNewVersionFromExisting(input.storeAppId, versionId);
  }

  const result: UpsertResult = {
    locale: appleLocale,
    versionLocalization: { action: "skipped", reason: "" },
    appInfoLocalization: { action: "skipped", reason: "" },
  };

  // PART A: Version Localization
  if (hasVersionFields(input.fields)) {
    const existing = await this.findVersionLocalization(versionId, appleLocale);
    if (existing) {
      try {
        await this.patchVersionLocalization(existing.id, input.fields);
        result.versionLocalization = { action: "updated", id: existing.id };
      } catch (e) {
        if (isConflictError(e)) {
          result.versionLocalization = { action: "skipped", reason: "state locked", error: e };
        } else throw e;
      }
    } else {
      const created = await this.createVersionLocalization(versionId, appleLocale, input.fields);
      result.versionLocalization = { action: "created", id: created.id };
    }
  }

  // PART B: App-Info Localization
  if (hasAppInfoFields(input.fields)) {
    const appInfoId = await this.getAppInfoId(input.storeAppId);
    const existing = await this.findAppInfoLocalization(appInfoId, appleLocale);
    if (existing) {
      try {
        await this.patchAppInfoLocalization(existing.id, input.fields);
        result.appInfoLocalization = { action: "updated", id: existing.id };
      } catch (e) {
        if (isConflictError(e)) {
          result.appInfoLocalization = { action: "skipped", reason: "state locked", error: e };
        } else throw e;
      }
    } else {
      const created = await this.createAppInfoLocalization(appInfoId, appleLocale, input.fields);
      result.appInfoLocalization = { action: "created", id: created.id };
    }
  }

  return result;
}
```

### 4.6.2 POST Create — Version Localization

C# kaynak: `CreateVersionLocalizationAsync()` (line 740-792).

```ts
async createVersionLocalization(versionId: string, locale: string, fields: LocalFields): Promise<{ id: string }> {
  const body = {
    data: {
      type: "appStoreVersionLocalizations",
      attributes: {
        locale,
        ...(fields.description != null && { description: fields.description }),
        ...(fields.keywords != null && { keywords: fields.keywords }),
        ...(fields.whatsNew != null && { whatsNew: fields.whatsNew }),
        ...(fields.promotionalText != null && { promotionalText: fields.promotionalText }),
        ...(fields.marketingUrl != null && { marketingUrl: fields.marketingUrl }),
        ...(fields.supportUrl != null && { supportUrl: fields.supportUrl }),
      },
      relationships: {
        appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
      },
    },
  };
  const res = await this.client.request<{ data: { id: string } }>({
    method: "POST",
    path: "/appStoreVersionLocalizations",
    body,
  });
  return { id: res.data.id };
}
```

> **Önemli:** Apple JSON:API'da `null` field göndermek "alanı sil" anlamına gelir. Mevcut C# kodu sadece `string.IsNullOrEmpty` olmayanları gönderiyor — Web tarafında da aynı pattern (`fields.X != null ? { X: fields.X } : {}`).

### 4.6.3 PATCH Update — Version Localization

```ts
async patchVersionLocalization(locId: string, fields: LocalFields): Promise<void> {
  const attributes: Record<string, string | null> = {};
  if (fields.description !== undefined) attributes.description = fields.description ?? "";
  if (fields.keywords !== undefined) attributes.keywords = fields.keywords ?? "";
  if (fields.whatsNew !== undefined) attributes.whatsNew = fields.whatsNew ?? "";
  if (fields.promotionalText !== undefined) attributes.promotionalText = fields.promotionalText ?? "";
  if (fields.marketingUrl !== undefined) attributes.marketingUrl = fields.marketingUrl ?? "";
  if (fields.supportUrl !== undefined) attributes.supportUrl = fields.supportUrl ?? "";

  await this.client.request({
    method: "PATCH",
    path: `/appStoreVersionLocalizations/${encodeURIComponent(locId)}`,
    body: { data: { type: "appStoreVersionLocalizations", id: locId, attributes } },
  });
}
```

> **Boş string vs null:** Apple `""` boş string verirseniz alanı temizler. `null` da aynı etki. Bizde `undefined` = "değiştirme", `""` veya `null` = "temizle".

### 4.6.4 Aynı pattern App-Info için

`CreateAppInfoLocalizationAsync` (line 853-909) + `PatchAppInfoLocalizationAsync` (line 914-963). Tek fark: type=`appInfoLocalizations`, alanlar `name`, `subtitle`, `privacyPolicyUrl`.

### 4.6.5 Version Settings Update

C# kaynak: `UpdateVersionSettingsAsync()` (line 994).

```ts
async updateVersionSettings(input: {
  versionId: string;
  versionString?: string;
  releaseType?: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";
  earliestReleaseDate?: string | null;  // ISO 8601, SCHEDULED için
  copyright?: string;
}): Promise<void> {
  const attributes: Record<string, unknown> = {};
  if (input.versionString) attributes.versionString = input.versionString;
  if (input.releaseType) attributes.releaseType = input.releaseType;
  if (input.releaseType === "SCHEDULED" && input.earliestReleaseDate) {
    attributes.earliestReleaseDate = input.earliestReleaseDate;
  }
  if (input.copyright !== undefined) attributes.copyright = input.copyright;

  await this.client.request({
    method: "PATCH",
    path: `/appStoreVersions/${encodeURIComponent(input.versionId)}`,
    body: { data: { type: "appStoreVersions", id: input.versionId, attributes } },
  });
}
```

## 4.7 Screenshots — `AppleScreenshots.ts`

### 4.7.1 Fetch (Pull) — Hiyerarşik 4-Adım

C# kaynak: `GetAllScreenshotsAsync()` (line 1063-1238).

```
Version → VersionLocalizations[]
   ↓
For each locale → ScreenshotSets[] (filter by displayType)
   ↓
For each set → Screenshots[]
   ↓
Each Screenshot → state, fileName, imageAsset URL template
```

```ts
export interface AppleScreenshotInfo {
  id: string;
  locale: string;
  displayType: string;       // APP_IPHONE_65, ...
  fileName: string;
  width: number;
  height: number;
  ordinal: number;
  state: string;
  url: string;               // signed, 24h valid
}

async fetchAllScreenshots(storeAppId: string): Promise<Map<string, Map<string, AppleScreenshotInfo[]>>> {
  // outer: locale → displayType → screenshots
  const out = new Map<string, Map<string, AppleScreenshotInfo[]>>();

  // 1) Latest version
  const version = await this.findLatestVersion(storeAppId);

  // 2) All localizations (max 50 per page, ~35 dil yeter)
  for await (const loc of this.client.paginate<JsonApiVersionLocalization>({
    path: `/appStoreVersions/${encodeURIComponent(version.id)}/appStoreVersionLocalizations`,
    query: { limit: 50 },
  })) {
    const localeMap = new Map<string, AppleScreenshotInfo[]>();
    out.set(loc.attributes.locale, localeMap);

    // 3) Screenshot sets for this localization
    for await (const set of this.client.paginate<JsonApiScreenshotSet>({
      path: `/appStoreVersionLocalizations/${encodeURIComponent(loc.id)}/appScreenshotSets`,
      query: { limit: 50 },
    })) {
      const displayType = set.attributes.screenshotDisplayType;
      const screenshots: AppleScreenshotInfo[] = [];
      localeMap.set(displayType, screenshots);

      // 4) Screenshots in this set
      for await (const ss of this.client.paginate<JsonApiScreenshot>({
        path: `/appScreenshotSets/${encodeURIComponent(set.id)}/appScreenshots`,
        query: { limit: 10 },
      })) {
        const asset = ss.attributes.imageAsset;
        const url = asset?.templateUrl?.replace("{w}", String(asset.width)).replace("{h}", String(asset.height)).replace("{f}", "png");
        screenshots.push({
          id: ss.id,
          locale: loc.attributes.locale,
          displayType,
          fileName: ss.attributes.fileName,
          width: asset?.width ?? 0,
          height: asset?.height ?? 0,
          ordinal: ss.attributes.displayOrdinal ?? 0,
          state: ss.attributes.assetDeliveryState?.state ?? "UNKNOWN",
          url: url ?? "",
        });
      }
    }
  }
  return out;
}
```

### 4.7.2 Upload (Push) — KRİTİK 3-Adım Protokol

C# kaynak: `UploadScreenshotAsync()` (line 1262-1543).

#### Adım 1 — Reserve (POST)

```ts
async reserveScreenshot(setId: string, fileName: string, fileSize: number): Promise<ReserveResult> {
  const body = {
    data: {
      type: "appScreenshots",
      attributes: { fileName, fileSize },
      relationships: {
        appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } },
      },
    },
  };
  const res = await this.client.request<{ data: JsonApiScreenshot }>({
    method: "POST",
    path: "/appScreenshots",
    body,
  });
  return {
    screenshotId: res.data.id,
    uploadOperations: res.data.attributes.uploadOperations, // S3 PUT operasyonları
  };
}
```

**Response shape (uploadOperations):**

```json
{
  "data": {
    "id": "abc-123",
    "type": "appScreenshots",
    "attributes": {
      "fileName": "iphone-65-1.png",
      "fileSize": 1456789,
      "uploadOperations": [
        {
          "method": "PUT",
          "url": "https://s3.us-east-1.amazonaws.com/...?X-Amz-Signature=...",
          "length": 1456789,
          "offset": 0,
          "requestHeaders": [
            { "name": "Content-Type", "value": "image/png" }
          ]
        }
      ]
    }
  }
}
```

> **Önemli:** Çoğu zaman tek operation döner (single PUT). Büyük dosya (>~10MB) gelirse chunked olabilir; bunu **destekleyici** kod yazmak gerek (offset + length kullanarak file stream'i seek edip PUT).

#### Adım 2 — Upload Chunks (PUT to S3)

```ts
async uploadChunks(
  filePath: string,
  operations: UploadOperation[],
  onProgress?: (bytesUploaded: number, totalBytes: number) => void
): Promise<void> {
  const fileStats = await fs.stat(filePath);
  const total = fileStats.size;
  let uploaded = 0;

  for (const op of operations) {
    const stream = createReadStream(filePath, { start: op.offset, end: op.offset + op.length - 1 });
    const headers: Record<string, string> = {};
    for (const h of op.requestHeaders) headers[h.name] = h.value;

    const res = await fetch(op.url, {
      method: op.method,
      headers,
      body: stream as any,           // node-fetch / undici: Readable stream OK
      duplex: "half",                 // undici fetch için gerekli
    });
    if (!res.ok) {
      throw new AppleUploadError(
        `S3 upload failed (op offset=${op.offset}): ${res.status} ${await res.text()}`
      );
    }
    uploaded += op.length;
    onProgress?.(uploaded, total);
  }
}
```

> **DİKKAT 1:** `Content-Type` header MUTLAKA `requestHeaders` içinden gelmeli — Apple bu değeri imzalıyor, değiştirirsen S3 imza fail.

> **DİKKAT 2:** `Content-Length` da gerekli — fetch otomatik koyar (stream length biliniyorsa).

> **DİKKAT 3:** S3 PUT'ta `Authorization` header **gönderme** — URL'in kendisinde presigned token var.

#### Adım 3 — Commit (PATCH)

```ts
async commitScreenshot(screenshotId: string, fileBuffer: Buffer): Promise<void> {
  const md5 = createHash("md5").update(fileBuffer).digest("hex");
  await this.client.request({
    method: "PATCH",
    path: `/appScreenshots/${encodeURIComponent(screenshotId)}`,
    body: {
      data: {
        type: "appScreenshots",
        id: screenshotId,
        attributes: {
          uploaded: true,
          sourceFileChecksum: md5,
        },
      },
    },
  });
}
```

> **DİKKAT:** `sourceFileChecksum` MD5 hex string — Apple bunu PUT edilen dosyanın MD5'i ile karşılaştırır; uyuşmazsa "UPLOAD_FAILED" state'ine düşer.

> **PERFORMANS:** Tüm dosyayı RAM'e alıp `Buffer`'dan MD5 hesaplamak küçük dosyalar (8 MB üst sınır) için problem değil. Daha büyük olsa stream-MD5 (`crypto.createHash("md5")` + pipe) tercih edilir.

#### Komple Upload Akışı (orchestrator)

```ts
async uploadScreenshot(input: {
  storeAppId: string;
  versionId: string;
  canonicalLocale: string;
  displayType: string;
  filePath: string;
  fileName: string;
  onProgress?: (current: number, total: number, step: string) => void;
}): Promise<{ screenshotId: string; state: string }> {
  const appleLocale = appleLocaleHelper.toApple(input.canonicalLocale);

  // 1. Localization lookup
  const loc = await this.findVersionLocalization(input.versionId, appleLocale);
  if (!loc) throw new ValidationError("Localization not found, push metadata first");

  // 2. Find or create screenshot set
  input.onProgress?.(1, 4, "Locating screenshot set");
  let set = await this.findScreenshotSet(loc.id, input.displayType);
  if (!set) {
    set = await this.createScreenshotSet(loc.id, input.displayType);
  }

  // 3. Reserve
  input.onProgress?.(2, 4, "Reserving asset on Apple");
  const fileBuffer = await fs.readFile(input.filePath);
  const reserve = await this.reserveScreenshot(set.id, input.fileName, fileBuffer.length);

  try {
    // 4. Upload to S3 (with progress)
    input.onProgress?.(3, 4, "Uploading to Apple S3");
    await this.uploadChunks(input.filePath, reserve.uploadOperations, (bytes, total) => {
      input.onProgress?.(3, 4, `Uploading ${Math.round((bytes / total) * 100)}%`);
    });

    // 5. Commit
    input.onProgress?.(4, 4, "Committing");
    await this.commitScreenshot(reserve.screenshotId, fileBuffer);

    return { screenshotId: reserve.screenshotId, state: "PROCESSING" };
  } catch (e) {
    // Cleanup orphan reservation (Apple lets you DELETE in-progress assets)
    try { await this.deleteScreenshot(reserve.screenshotId); } catch {}
    throw e;
  }
}
```

### 4.7.3 Reorder

C# kaynak: `BulkReorderScreenshotsAsync` (Apple JSON:API relationships endpoint kullanıyor).

```ts
async reorderScreenshots(setId: string, orderedIds: string[]): Promise<void> {
  await this.client.request({
    method: "PATCH",
    path: `/appScreenshotSets/${encodeURIComponent(setId)}/relationships/appScreenshots`,
    body: {
      data: orderedIds.map((id) => ({ type: "appScreenshots", id })),
    },
  });
}
```

### 4.7.4 Delete

```ts
async deleteScreenshot(screenshotId: string): Promise<void> {
  await this.client.request({
    method: "DELETE",
    path: `/appScreenshots/${encodeURIComponent(screenshotId)}`,
  });
}
```

### 4.7.5 Screenshot Spec Tablosu

C# kaynak: `ScreenshotManager.cs:35-221` `iOSDeviceSpecs` dictionary.

`packages/core/src/validation/screenshotSpecs.ts` olarak port:

```ts
export interface IosScreenshotSpec {
  id: string;                  // "APP_IPHONE_65"
  displayName: string;         // "iPhone 6.5\""
  primaryWidth: number;
  primaryHeight: number;
  validSizes: Array<[number, number]>;  // portrait + landscape
  minRequired: number;
  maxAllowed: number;          // 10 her zaman
  isRequired: boolean;
  description: string;
}

export const IOS_SCREENSHOT_SPECS: Record<string, IosScreenshotSpec> = {
  APP_IPHONE_65: {
    id: "APP_IPHONE_65", displayName: "iPhone 6.5\"",
    primaryWidth: 1284, primaryHeight: 2778,
    validSizes: [
      [1284, 2778], [2778, 1284],   // portrait + landscape
      [1242, 2688], [2688, 1242],   // older iPhone Max
    ],
    minRequired: 1, maxAllowed: 10, isRequired: true,
    description: "PRIMARY — iPhone 6.5\". Apple scales all other iPhone sizes from this.",
  },
  APP_IPAD_PRO_3GEN_129: {
    id: "APP_IPAD_PRO_3GEN_129", displayName: "iPad Pro 12.9\" (3rd Gen+)",
    primaryWidth: 2048, primaryHeight: 2732,
    validSizes: [[2048, 2732], [2732, 2048]],
    minRequired: 1, maxAllowed: 10, isRequired: true,
    description: "PRIMARY — frameless iPad Pro 12.9\".",
  },
  // ... APP_IPHONE_69, APP_IPHONE_63, APP_IPHONE_61, APP_IPHONE_55, APP_IPHONE_47,
  //     APP_IPHONE_40, APP_IPHONE_35, APP_IPAD_11, APP_IPAD_PRO_129, APP_IPAD_105, APP_IPAD_97
  // (mevcut ScreenshotManager.cs:35-221'den birebir port)
};

export function validateIosScreenshot(displayType: string, width: number, height: number, fileSizeBytes: number): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (fileSizeBytes > 8 * 1024 * 1024) {
    errors.push(`File too large (${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB) — max 8 MB`);
  }

  const spec = IOS_SCREENSHOT_SPECS[displayType];
  if (!spec) {
    warnings.push(`Unknown displayType '${displayType}' — Apple will validate server-side`);
    return { errors, warnings };
  }

  const validSize = spec.validSizes.some(([w, h]) => w === width && h === height);
  if (!validSize) {
    errors.push(
      `Invalid dimensions ${width}×${height} for ${spec.displayName}. Accepted: ${spec.validSizes.map(([w, h]) => `${w}×${h}`).join(", ")}`
    );
  }

  return { errors, warnings };
}
```

## 4.8 App Previews — `AppleAppPreviews.ts`

C# kaynak: `AppPreviewManager.cs` + `AppStoreConnectAPI.cs:1575-1981`.

**Screenshot ile farklar:**

| Konu | Screenshot | App Preview |
|------|-----------|-------------|
| Endpoint set | `/appScreenshotSets` | `/appPreviewSets` |
| Endpoint asset | `/appScreenshots` | `/appPreviews` |
| Display type isim | `APP_IPHONE_65` | `IPHONE_65` (APP_ prefix YOK) |
| File size limit | 8 MB | 500 MB |
| MIME | image/png, image/jpeg | video/mp4, video/quicktime (.mov), video/x-m4v |
| Max count | 10 | 3 |
| Reserve body | `{ fileName, fileSize }` | `{ fileName, fileSize, mimeType }` — **mimeType ZORUNLU** |
| Commit body | `{ uploaded, sourceFileChecksum }` | Aynı |
| Magic byte sniff | PNG, JPEG header | MP4: byte 4-7 = "ftyp" (ISO base media) |

### 4.8.1 Display Type Conversion

```ts
// Screenshot displayType → Preview previewType
export function screenshotToPreviewType(displayType: string): string {
  return displayType.replace(/^APP_/, "");
  // "APP_IPHONE_65" → "IPHONE_65"
  // "APP_IPAD_PRO_3GEN_129" → "IPAD_PRO_3GEN_129"
}
```

> Bu detayın atlanması mevcut C# kodunda 2x işlem zinciri üretmiş (`ScreenshotManager.cs:711` + `AppStoreConnectAPI.cs:1741-1743`). Web tarafında **tek yerde** yap.

### 4.8.2 Video Magic Byte Validation

C# kaynak: `AppPreviewManager.cs:524-544`.

```ts
export async function isValidMp4Container(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(12);
    await handle.read(buf, 0, 12, 0);
    // ISO base media: bytes 4..7 = "ftyp"
    return buf.subarray(4, 8).toString("ascii") === "ftyp";
  } finally {
    await handle.close();
  }
}
```

### 4.8.3 Upload Akışı

Screenshot upload ile **bire bir aynı** (reserve → PUT chunks → commit). Tek farklar yukarıdaki tabloda. Code reuse için `AbstractAssetUploader` base sınıf oluştur, `AppleScreenshots` ve `AppleAppPreviews` extend etsin.

```ts
abstract class AbstractAssetUploader<TReserveAttrs> {
  protected abstract reserveEndpoint(): string;          // "/appScreenshots" veya "/appPreviews"
  protected abstract assetEndpoint(): string;            // aynı (PATCH için)
  protected abstract setEndpoint(setId: string): string; // "/appScreenshotSets/{id}" vs

  protected abstract buildReserveAttributes(input: ReserveInput): TReserveAttrs;
  protected abstract setRelationshipType(): string;      // "appScreenshotSets" vs

  async upload(input: UploadInput): Promise<UploadResult> {
    // 1. Reserve
    // 2. PUT chunks
    // 3. PATCH commit
    // Ortak kod tek yerde
  }
}

class AppleScreenshotUploader extends AbstractAssetUploader<{ fileName: string; fileSize: number }> {
  // override sadece reserve attrs + endpoint isimleri
}

class AppleAppPreviewUploader extends AbstractAssetUploader<{ fileName: string; fileSize: number; mimeType: string }> {
  // override
}
```

## 4.9 Builds & Submission — `AppleBuilds.ts`

C# kaynak: `AppStoreConnectAPI.cs:1984-2524`.

### 4.9.1 List Builds

```ts
async listBuilds(storeAppId: string, limit = 20): Promise<BuildInfo[]> {
  const res = await this.client.request<JsonApiBuildsResponse>({
    method: "GET",
    path: "/builds",
    query: {
      "filter[app]": storeAppId,
      sort: "-uploadedDate",
      limit,
      include: "preReleaseVersion",   // <-- nested data için
    },
  });
  // res.data: builds
  // res.included: preReleaseVersions (map by ID → versionString)
  const versionMap = new Map<string, string>();
  for (const inc of res.included ?? []) {
    if (inc.type === "preReleaseVersions") {
      versionMap.set(inc.id, inc.attributes.version);
    }
  }
  return res.data.map((b) => ({
    id: b.id,
    version: versionMap.get(b.relationships?.preReleaseVersion?.data?.id ?? "") ?? "",
    buildNumber: b.attributes.version,    // CFBundleVersion
    uploadedDate: b.attributes.uploadedDate,
    processingState: b.attributes.processingState,
    usesNonExemptEncryption: b.attributes.usesNonExemptEncryption,
    iconAssetToken: b.attributes.iconAssetToken,
  }));
}
```

### 4.9.2 Submit for Review

C# kaynak: `SubmitForReviewAsync()` (line 2191-2286). **3-adımlı:**

```ts
async submitForReview(storeAppId: string, versionId: string): Promise<void> {
  // 1. Create review submission
  const submission = await this.client.request<{ data: { id: string } }>({
    method: "POST",
    path: "/reviewSubmissions",
    body: {
      data: {
        type: "reviewSubmissions",
        attributes: {},
        relationships: { app: { data: { type: "apps", id: storeAppId } } },
      },
    },
  });

  // 2. Link version to submission
  await this.client.request({
    method: "POST",
    path: "/reviewSubmissionItems",
    body: {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submission.data.id } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    },
  });

  // 3. Submit
  await this.client.request({
    method: "PATCH",
    path: `/reviewSubmissions/${encodeURIComponent(submission.data.id)}`,
    body: {
      data: {
        type: "reviewSubmissions",
        id: submission.data.id,
        attributes: { submitted: true },
      },
    },
  });
}
```

### 4.9.3 Create New Version

C# kaynak: `CreateAppStoreVersionAsync()` (line 2341).

```ts
async createAppStoreVersion(input: {
  storeAppId: string;
  versionString: string;
  platform?: "IOS" | "MAC_OS" | "TV_OS";
  releaseType?: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";
}): Promise<{ versionId: string }> {
  const res = await this.client.request<{ data: { id: string } }>({
    method: "POST",
    path: "/appStoreVersions",
    body: {
      data: {
        type: "appStoreVersions",
        attributes: {
          versionString: input.versionString,
          platform: input.platform ?? "IOS",
          releaseType: input.releaseType ?? "MANUAL",
        },
        relationships: { app: { data: { type: "apps", id: input.storeAppId } } },
      },
    },
  });
  return { versionId: res.data.id };
}
```

## 4.10 Locale Helper — `AppleLocale.ts`

C# kaynak: `AppStoreConnectAPI.cs:2810-2943` `AppleLocaleHelper` + `LocaleConverter.cs:258-390` `ToAppleMap`.

```ts
// Canonical (master JSON) locale → Apple locale
const APPLE_LOCALE_MAP: Record<string, string> = {
  // exact mappings from LocaleConverter.cs
  "en-US": "en-US",
  "en-GB": "en-GB",
  "en-CA": "en-CA",
  "en-AU": "en-AU",
  "tr-TR": "tr",
  "tr": "tr",
  "ja-JP": "ja",
  "ja": "ja",
  "ko-KR": "ko",
  "ko": "ko",
  "zh-Hans": "zh-Hans",
  "zh-CN": "zh-Hans",
  "zh-Hant": "zh-Hant",
  "zh-TW": "zh-Hant",
  "zh-HK": "zh-HK",
  "he-IL": "he",        // İBRANİCE: Apple "he"; Google "iw-IL" (FARK!)
  "he": "he",
  "ar-SA": "ar-SA",
  "ar": "ar-SA",
  "es-ES": "es-ES",
  "es-MX": "es-MX",
  "es-419": "es-MX",     // Latin America
  "pt-BR": "pt-BR",
  "pt-PT": "pt-PT",
  "fr-FR": "fr-FR",
  "fr-CA": "fr-CA",
  // ... (LocaleConverter.cs:258-390'dan tüm liste)
};

export function toAppleLocale(canonical: string): string {
  if (APPLE_LOCALE_MAP[canonical]) return APPLE_LOCALE_MAP[canonical];
  // Fallback: "xx-YY" → "xx-YY", "xx" → "xx"
  const [base] = canonical.split("-");
  if (APPLE_LOCALE_MAP[base]) return APPLE_LOCALE_MAP[base];
  // Default: olduğu gibi (Apple validate eder)
  return canonical;
}
```

## 4.11 Error Sınıflandırma — `AppleErrors.ts`

```ts
export class AppleApiError extends Error {
  constructor(
    message: string,
    public code: "UPSTREAM_ERROR" | "CREDENTIAL_INVALID" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "VALIDATION_ERROR",
    public httpStatus: number,
    public appleErrorCode?: string,
    public appleErrorDetail?: string,
    public retryable: boolean = false
  ) { super(message); }
}

export function classifyAppleError(httpStatus: number, body: any): AppleApiError {
  const err = body?.errors?.[0];
  const detail = err?.detail ?? err?.title ?? "Unknown Apple error";
  const code = err?.code;

  if (httpStatus === 401) return new AppleApiError(detail, "CREDENTIAL_INVALID", 401, code, detail, false);
  if (httpStatus === 403) return new AppleApiError(detail, "CREDENTIAL_INVALID", 403, code, detail, false);
  if (httpStatus === 404) return new AppleApiError(detail, "NOT_FOUND", 404, code, detail, false);
  if (httpStatus === 409) return new AppleApiError(detail, "CONFLICT", 409, code, detail, false);
  if (httpStatus === 422) return new AppleApiError(detail, "VALIDATION_ERROR", 422, code, detail, false);
  if (httpStatus === 429) return new AppleApiError(detail, "RATE_LIMITED", 429, code, detail, true);
  if (httpStatus >= 500) return new AppleApiError(detail, "UPSTREAM_ERROR", httpStatus, code, detail, true);
  return new AppleApiError(detail, "UPSTREAM_ERROR", httpStatus, code, detail, false);
}

export function isConflictError(e: unknown): boolean {
  return e instanceof AppleApiError && e.code === "CONFLICT";
}
```

**Retry stratejisi (BullMQ ile):**
- `retryable=true` (502/503/504/429) → exponential backoff: 5s, 15s, 45s, max 3 deneme
- Rate limit (429) → `Retry-After` header'a saygı duy

## 4.12 Edge Case'ler ve Gotcha'lar

| # | Konu | C# kaynak | Web çözüm |
|---|------|-----------|----------|
| 1 | Token expire mid-request | `AppleClient.cs:103-118` | `AppleAuth.getToken` cache + 5dk önce refresh |
| 2 | Pagination infinite loop | `AppStoreConnectAPI.cs:364` | `pageLimit: 50` hard cap |
| 3 | 409 state locked field | `AppStoreConnectAPI.cs:900-903` | Per-field try/catch, log warning, devam et |
| 4 | Screenshot ID slot collision (aynı ordinal'a 2 farklı dosya) | C#'ta yok | DB unique constraint + 409 friendly mesaj |
| 5 | Orphan reservation (reserve sonrası PUT fail) | C#'ta cleanup yok | finally block'ta `deleteScreenshot()` çağır |
| 6 | App preview previewType "APP_" stripping | `ScreenshotManager.cs:711` | `screenshotToPreviewType()` helper |
| 7 | `sourceFileChecksum` MD5 yanlış format | C# `BitConverter.ToString().Replace("-", "")` | `crypto.createHash("md5").digest("hex")` |
| 8 | S3 PUT `Authorization` header (yanlış inject) | — | fetch ile asla `Authorization` koyma, sadece `requestHeaders[]` |
| 9 | Apple JSON parse error (malformed response) | C# `MiniJSON.Deserialize` | `try { await res.json() } catch` → CredentialInvalid varsay |
| 10 | RTL/Arabic karakter encoding | `MetadataManager.cs:867` | Node native UTF-8; Buffer.from(text, "utf-8") |
| 11 | Locale "en-US" → "en" yanlış (Apple "en-US" bekler) | `LocaleConverter.cs:259` | Map'te exact tutuluyor |
| 12 | Version state "READY_FOR_SALE" düzenlenemez | `AppStoreConnectAPI.cs:573-609` | Auto create new version with versionString bump |
| 13 | Screenshot set displayType exact match | `AppStoreConnectAPI.cs:1326-1361` | createSet(displayType) idempotent |
| 14 | `whatsNew` boş string Apple reject | C# `Length > 0` kontrol | `fields.whatsNew !== undefined && fields.whatsNew.length > 0` |

## 4.13 Mock Stratejisi (Test için)

`packages/core/src/adapters/apple/__tests__/fixtures/` altına:

```
apple-listApps-response.json
apple-getApp-response.json
apple-appInfoLocalizations-page1.json
apple-appInfoLocalizations-page2.json
apple-versionLocalizations-page1.json
apple-screenshots-set-iphone65.json
apple-reserveScreenshot-response.json   ← uploadOperations[]
apple-s3-put-success.txt
apple-commitScreenshot-response.json
apple-error-401.json
apple-error-409-version-locked.json
```

Vitest + `msw` ile:

```ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

const handlers = [
  http.post("https://api.appstoreconnect.apple.com/v1/appScreenshots", () =>
    HttpResponse.json(require("./fixtures/apple-reserveScreenshot-response.json"))
  ),
  // ...
];
const server = setupServer(...handlers);
beforeAll(() => server.listen());
```

## 4.14 Test Senaryoları (mutlaka olması gerekenler)

1. **JWT generation determinism** — aynı input için aynı output (signature non-deterministic olsa da header+payload aynı)
2. **Token cache hit** — iki çağrı, sadece bir JWT üretildi
3. **Token cache miss (expire)** — TTL geçince yeniden üretti
4. **Locale normalization edge cases** — `he-IL` → `he`, `zh-Hans` → `zh-Hans`, bilinmeyen `xx-YY` → `xx-YY`
5. **Metadata pull merge** — appInfo + version locale'leri doğru birleştirir, yalnız birinde olan locale de döner
6. **Metadata push create vs update** — locale yoksa POST, varsa PATCH
7. **Metadata push 409 graceful** — bir field locked iken diğerleri yine update edildi
8. **Screenshot upload happy path** — reserve → PUT → commit, DB'ye doğru kayıt
9. **Screenshot upload S3 fail** → cleanup (reservation deleted)
10. **Screenshot upload chunked** — 2+ operation döner, hepsi PUT
11. **Screenshot validation reject** — 9 MB dosya → ValidationError, API'ya hiç gitmez
12. **App preview validation reject** — .png uzantılı dosya → "Invalid format"
13. **App preview magic byte fail** — .mp4 uzantılı ama içeriği PNG → "Not a valid MP4 container"
14. **Reorder bulk PATCH** — 5 screenshot'un ordinal'ı değişti, tek istek
15. **Build list with included** — preReleaseVersions doğru parse + versionString match
16. **Submit for review 3-adım** — hata olursa hangi adımda olduğu açık
17. **AbortSignal** — uzun süren request kullanıcı tarafından cancel edilebilir (job cancel)
18. **Rate limit 429** — `Retry-After` saygısı, retry yapıldı
