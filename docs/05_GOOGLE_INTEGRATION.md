# 05 — Google Play Integration

Bu doküman, Google Play Console metadata + screenshots + app previews + AAB build yönetiminin Release Flight'ye nasıl entegre edildiğini açıklar. Hedef paket: `packages/core/src/adapters/google/`.


## 5.0 Referanslar

- Android Publisher API v3: https://developers.google.com/android-publisher
- OAuth 2 service account flow: https://developers.google.com/identity/protocols/oauth2/service-account

## 5.1 Modüller

```
packages/core/src/adapters/google/
├── GoogleClient.ts             # HTTP wrapper + OAuth token
├── GoogleAuth.ts               # Service account RS256 → access_token
├── GoogleApps.ts               # Yok — Google Play "list apps" endpoint sunmaz
├── GoogleEditSession.ts        # Edit lifecycle (open/discard/commit + smart commit)
├── GoogleListings.ts           # Metadata pull/push
├── GoogleImages.ts             # Screenshot + icon + featureGraphic + tvBanner + promo
├── GoogleTracks.ts             # AAB → internal/alpha/beta/production
├── GoogleAabUpload.ts          # Bundle upload + deobfuscation
├── GoogleErrors.ts
├── GoogleLocale.ts             # LocaleConverter port (77+ locale)
├── types/
└── __tests__/
```

## 5.2 Authentication — `GoogleAuth.ts`

### 5.2.1 Service Account JSON Yapısı

```json
{
  "type": "service_account",
  "project_id": "my-project-12345",
  "private_key_id": "abcd...",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
  "client_email": "service-account@my-project.iam.gserviceaccount.com",
  "client_id": "123456789012345",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "...",
  "client_x509_cert_url": "..."
}
```

### 5.2.2 OAuth2 JWT Bearer Flow (RS256)

C# kaynak: `JWTHelper.cs:25-57` + `GooglePlayAPI.cs:163-219`.

```ts
import { createSign, createPrivateKey } from "node:crypto";

export interface GoogleCredentialMaterial {
  clientEmail: string;
  privateKeyPem: string;
  projectId: string;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const SCOPES = {
  GOOGLE_PLAY: "https://www.googleapis.com/auth/androidpublisher",
};

export class GoogleAuth {
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  async getAccessToken(cred: GoogleCredentialMaterial, scope: string): Promise<string> {
    const cacheKey = `${cred.clientEmail}:${scope}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    // 1) Service account JWT (RS256)
    const jwt = this.createServiceAccountJwt(cred, scope);

    // 2) Exchange JWT for access token
    const params = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new GoogleAuthError(`Token exchange failed: ${res.status} ${body}`);
    }
    const data = await res.json() as { access_token: string; expires_in: number; token_type: string };

    this.tokenCache.set(cacheKey, {
      token: data.access_token,
      // Google says 60 dk; biz 55 dk cacheliyoruz (5 dk safety)
      expiresAt: Date.now() + Math.min(data.expires_in - 300, 55 * 60) * 1000,
    });
    return data.access_token;
  }

  private createServiceAccountJwt(cred: GoogleCredentialMaterial, scope: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: cred.clientEmail,
      scope,
      aud: GOOGLE_TOKEN_URL,
      exp: now + 3600,
      iat: now,
    };
    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const keyObj = createPrivateKey({ key: cred.privateKeyPem, format: "pem" });
    if (keyObj.asymmetricKeyType !== "rsa") {
      throw new GoogleAuthError("Service account private_key is not RSA");
    }
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const sig = signer.sign(keyObj);
    return `${signingInput}.${base64UrlEncode(sig)}`;
  }
}
```

> **DİKKAT:** Service account JSON'daki `private_key` field'ı `\n` karakterleri **string olarak escape edilmiş** (literal `\` + `n`). JSON.parse zaten gerçek newline'a çevirir. Manuel okurken bu detay önemli.

### 5.2.3 Test Connection

```ts
async testGooglePlayConnection(cred: GoogleCredentialMaterial): Promise<TestResult> {
  try {
    const token = await this.getAccessToken(cred, SCOPES.GOOGLE_PLAY);
    return { ok: true, message: "Connected" };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}
```

> Google Play'de "list apps" endpoint yok; sadece auth başarılı olunca yeşil işaret yeterli.

## 5.3 HTTP Layer — `GoogleClient.ts`

```ts
const BASE_URL = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD_URL = "https://www.googleapis.com/upload/androidpublisher/v3/applications";

export class GoogleClient {
  constructor(private auth: GoogleAuth, private cred: GoogleCredentialMaterial) {}

  async request<T>(opts: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;           // path = "/{packageName}/edits/{editId}/listings"
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown | Buffer | Readable;
    contentType?: string;   // default application/json; "application/octet-stream" for binary
    timeoutMs?: number;
    silent?: boolean;       // GooglePlayAPI.cs silent mode
    signal?: AbortSignal;
  }): Promise<T> {
    const token = await this.auth.getAccessToken(this.cred, SCOPES.GOOGLE_PLAY);
    const url = new URL(BASE_URL + opts.path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      if (Buffer.isBuffer(opts.body)) {
        headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
        body = opts.body;
      } else if (opts.body instanceof Readable) {
        headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
        body = opts.body as any;
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    opts.signal?.addEventListener("abort", () => controller.abort());

    try {
      const res = await fetch(url.toString(), { method: opts.method, headers, body, signal: controller.signal, duplex: body instanceof Readable ? "half" : undefined });
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      if (!res.ok) throw classifyGoogleError(res.status, parsed, opts.silent);
      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

> **Path: packageName URL-escape** — `com.foo.bar` özel karakter içermez ama gelecek-proof: `encodeURIComponent(packageName)`.

> **Upload endpoint farklı host** — `UPLOAD_URL` ile başlar (`/upload/androidpublisher/...`); ayrı method olarak `uploadRequest()` yaz veya `request()` içine `baseOverride` ekle.

## 5.4 Edit Session Lifecycle — `GoogleEditSession.ts` (KRİTİK)

C# kaynak: `GooglePlayAPI.cs:499-773` + `GooglePlayAPI.cs:781-957`.

### 5.4.1 Lifecycle Diagramı

```
┌──────────────────┐
│  POST /edits     │ → editId döner (24 saat valid)
└────────┬─────────┘
         │
         ├──── GET /details
         ├──── GET /listings  (var olanları oku)
         ├──── PUT /listings/{lang}  (oluştur/güncelle)
         ├──── DELETE /listings/{lang}/{imageType}/{imgId}
         ├──── POST /upload/listings/{lang}/{imageType}
         ├──── POST /bundles?uploadType=media  (AAB)
         ├──── PUT /tracks/{name}
         │       ...
         ▼
┌──────────────────────────────────────────┐
│ POST /edits/{editId}:commit              │ → değişiklikler LIVE
│   ?changesNotSentForReview=true   ← managed publishing için
└──────────────────────────────────────────┘
         veya
┌──────────────────────────────────────────┐
│ DELETE /edits/{editId}                   │ → DISCARD
└──────────────────────────────────────────┘
```

> **KURAL #1:** Commit olmadan **değişiklik kaybolur**. Edit session 24 saat sonra otomatik discard olur.

> **KURAL #2:** Aynı anda bir uygulamada **sadece bir edit session açık olabilir**. Eşzamanlı 2 user → conflict → "Edit already exists".

### 5.4.2 Açma/Kapama

```ts
export class GoogleEditSession {
  constructor(private client: GoogleClient) {}

  async open(packageName: string): Promise<string> {
    const res = await this.client.request<{ id: string; expiryTimeSeconds: string }>({
      method: "POST",
      path: `/${encodeURIComponent(packageName)}/edits`,
    });
    return res.id;
  }

  async discard(packageName: string, editId: string): Promise<void> {
    await this.client.request({
      method: "DELETE",
      path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}`,
    });
  }

  async commit(packageName: string, editId: string, changesNotSentForReview = false): Promise<void> {
    const path = `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}:commit`;
    const query = changesNotSentForReview ? { changesNotSentForReview: "true" } : undefined;
    await this.client.request({ method: "POST", path, query });
  }
}
```

### 5.4.3 Smart Commit Strategy (KRİTİK)

C# kaynak: `GooglePlayAPI.cs:499-773` — uygulamanın yayın durumuna göre 4 farklı commit stratejisi:

```ts
export type CommitStrategy =
  | "managed_publishing"      // ?changesNotSentForReview=true
  | "simple"                  // direkt commit
  | "draft_autosave"          // commit fail ama metadata zaten kaydedildi
  | "auto_review";            // simple ama auto-review

export interface CommitResult {
  ok: boolean;
  strategy: CommitStrategy | null;
  message: string;
  retriedAs?: CommitStrategy;
}

export async function tryCommitEdit(
  client: GoogleClient,
  session: GoogleEditSession,
  packageName: string,
  editId: string
): Promise<CommitResult> {
  // 1) Önce managed publishing dene (en yaygın güvenli yol)
  try {
    await session.commit(packageName, editId, true);
    return { ok: true, strategy: "managed_publishing", message: "Committed (managed publishing)" };
  } catch (e1: any) {
    const msg1 = e1.message ?? "";

    // Auto-review uygulaması — "changesNotSentForReview must not be set"
    if (msg1.includes("changesNotSentForReview must not be set")) {
      try {
        await session.commit(packageName, editId, false);
        return { ok: true, strategy: "auto_review", message: "Committed (auto-review enabled)" };
      } catch (e2: any) {
        return { ok: false, strategy: null, message: `Auto-review commit failed: ${e2.message}` };
      }
    }

    // Draft app — "Only releases with status draft" → metadata zaten otomatik kaydedildi!
    if (msg1.includes("Only releases with status draft") ||
        msg1.includes("no committable releases") ||
        msg1.includes("no committable changes")) {
      // Edit'i temizle ki orphan kalmasın
      try { await session.discard(packageName, editId); } catch {}
      return {
        ok: true,
        strategy: "draft_autosave",
        message: "Draft app — metadata auto-saved; commit not required",
      };
    }

    // Genel commit fail
    return { ok: false, strategy: null, message: msg1 };
  }
}
```

> **DİKKAT — Draft autosave** (`GooglePlayAPI.cs:721-740`): Google Play'de hiç release yapılmamış (draft) bir uygulamanın metadata değişiklikleri **otomatik kaydedilir**. Commit endpoint hata döner ama bu **SUCCESS** sayılır. Bu eşik C# kodunda yakalanmamış olsa, kullanıcı her seferinde "commit failed" görür ama metadata aslında yüklenmiştir → çok kafa karıştırıcı.

> **DİKKAT — Orphan edit:** Commit fail olunca edit 24 saat ortada kalır → kullanıcı tekrar push'ta "edit already exists" alır. `discard()` her başarısızlık path'inde garantili çalışmalı (finally block).

### 5.4.4 Concurrency Lock

Eşzamanlı 2 push'u önlemek için **Redis distributed lock**:

```ts
async withEdit<T>(packageName: string, fn: (editId: string) => Promise<T>): Promise<T> {
  const lockKey = `lock:google-edit:${packageName}`;
  const lockValue = randomUUID();
  const acquired = await redis.set(lockKey, lockValue, "NX", "PX", 10 * 60 * 1000);
  if (acquired !== "OK") throw new ConflictError("Another edit session is in progress");
  const editId = await this.open(packageName);
  try {
    return await fn(editId);
  } finally {
    try { await tryCommitEdit(this.client, this, packageName, editId); } catch {}
    // Lock release (Lua script ile sadece kendi value'muzu silelim)
    await redis.eval(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end`, 1, lockKey, lockValue);
  }
}
```

## 5.5 Metadata Pull — `GoogleListings.ts`

C# kaynak: `GooglePlayAPI.cs:285-384` `GetAppFullDetailsAsync()`.

```ts
export interface GoogleListingData {
  language: string;             // Google format (örn. "en-US", "tr-TR", "iw-IL")
  title: string;                // ≤50
  shortDescription: string;     // ≤80
  fullDescription: string;      // ≤4000
  video: string;                // YouTube URL
}

async fetchAllListings(packageName: string): Promise<Map<string, GoogleListingData>> {
  return await this.session.withEdit(packageName, async (editId) => {
    // Get app details (default language, contact info)
    const details = await this.client.request<{
      defaultLanguage: string;
      contactEmail: string;
      contactWebsite: string;
      contactPhone?: string;
    }>({
      method: "GET",
      path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/details`,
      silent: true,
    });

    // Get all listings
    const res = await this.client.request<{ listings: GoogleListingData[] }>({
      method: "GET",
      path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/listings`,
      silent: true,
    });

    const map = new Map<string, GoogleListingData>();
    for (const l of res.listings ?? []) {
      map.set(l.language, l);
    }
    return map;
  });
}
```

> **Edit session pull amacıyla açılıyorsa** — `discard()` çağrılmalı (commit gereksiz, hatta zararlı). `withEdit` finally block'unda commit yerine sadece discard yapan bir varyant: `withEditReadOnly()`.

## 5.6 Metadata Push — `GoogleListings.ts` (devam)

C# kaynak: `GooglePlayAPI.cs:395-480` `UpdateMetadataAsync()` + `UpdateAllMetadataAsync()` (line 781-957).

### 5.6.1 Tek Listing Update

```ts
async upsertListing(editId: string, packageName: string, listing: GoogleListingData): Promise<void> {
  const path = `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(listing.language)}`;
  await this.client.request({
    method: "PUT",
    path,
    body: {
      language: listing.language,
      title: listing.title,
      shortDescription: listing.shortDescription,
      fullDescription: listing.fullDescription,
      video: listing.video || undefined,
    },
  });
}
```

> Google PUT = upsert (yoksa oluştur, varsa overwrite).

### 5.6.2 Bulk Push (Tüm Locale'ler)

```ts
async pushAllListings(input: {
  packageName: string;
  localizations: Array<{
    canonicalLocale: string;
    name: string;
    shortDescription: string;
    description: string;
    videoUrl?: string;
  }>;
  onProgress?: (current: number, total: number, locale: string) => void;
}): Promise<PushSummary> {
  const summary: PushSummary = { succeeded: [], failed: [], unsupported: [] };

  return await this.session.withEdit(input.packageName, async (editId) => {
    let i = 0;
    for (const loc of input.localizations) {
      i++;
      input.onProgress?.(i, input.localizations.length, loc.canonicalLocale);

      // Locale conversion
      const googleLocale = toGooglePlayLocale(loc.canonicalLocale);
      if (!isGooglePlaySupported(googleLocale)) {
        summary.unsupported.push({ canonical: loc.canonicalLocale, attempted: googleLocale });
        continue;
      }

      try {
        await this.upsertListing(editId, input.packageName, {
          language: googleLocale,
          title: loc.name,
          shortDescription: loc.shortDescription,
          fullDescription: loc.description,
          video: loc.videoUrl ?? "",
        });
        summary.succeeded.push({ canonical: loc.canonicalLocale, google: googleLocale });
      } catch (e: any) {
        summary.failed.push({ canonical: loc.canonicalLocale, error: e.message });
      }
    }
    // commit (smart strategy) — withEdit içinde otomatik
    return summary;
  });
}
```

> **DİKKAT:** Commit `withEdit`'in finally'sinde otomatik. Eğer locale'lerin yarısı fail oldu, yarısı başarılı → kullanıcının kararı? `withEdit`'in finally'si **her durumda commit dener** — yani başarılı yarısı yine canlı olur. Bu, mevcut C# kodunun davranışıyla aynı (`UpdateAllMetadataAsync` line 934).

### 5.6.3 Detaylı Locale Match Stratejisi

Mevcut C# kodunda (`UpdateAllMetadataAsync` line 814-852) listing önce var mı diye kontrol edilip create/update ayrımı yapılıyor. Ama Google'da PUT zaten upsert → bizde gereksiz GET; doğrudan PUT.

## 5.7 Images — `GoogleImages.ts`

C# kaynak: `GooglePlayAPI.cs:966-1095` (pull) + `1100-1240` (push/delete).

### 5.7.1 Image Types Reference

| Image Type | Boyut | Max Count | Notes |
|------------|-------|-----------|-------|
| `phoneScreenshots` | 320-3840 her boyut | 8 | En az 2 zorunlu |
| `sevenInchScreenshots` | aynı | 8 | Opsiyonel |
| `tenInchScreenshots` | aynı | 8 | Opsiyonel |
| `tvScreenshots` | 1920×... | 8 | Android TV |
| `wearScreenshots` | 384×384 | 8 | Wear OS |
| `icon` | 512×512 (exact) | 1 | Zorunlu |
| `featureGraphic` | 1024×500 (exact) | 1 | Featured için zorunlu |
| `tvBanner` | 1280×720 | 1 | Android TV |
| `promoGraphic` | 180×120 | 1 | Eski format, opsiyonel |

### 5.7.2 Fetch

```ts
async fetchAllImages(packageName: string): Promise<Map<string, GoogleImagesByLanguage>> {
  // GoogleImagesByLanguage: { phoneScreenshots[], icon, featureGraphic, ... }
  return await this.session.withEditReadOnly(packageName, async (editId) => {
    // Önce hangi diller var?
    const listings = await this.fetchListingsForDiscovery(editId, packageName);
    const out = new Map<string, GoogleImagesByLanguage>();

    for (const lang of listings.keys()) {
      const imageSet: GoogleImagesByLanguage = {
        language: lang,
        phoneScreenshots: [], sevenInchScreenshots: [], tenInchScreenshots: [],
        tvScreenshots: [], wearScreenshots: [],
        icon: null, featureGraphic: null, tvBanner: null, promoGraphic: null,
      };

      for (const type of ALL_IMAGE_TYPES) {
        const path = `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(lang)}/${type}`;
        try {
          const res = await this.client.request<{ images: GoogleImage[] }>({
            method: "GET", path, silent: true,
          });
          if (type === "icon") imageSet.icon = res.images?.[0] ?? null;
          else if (type === "featureGraphic") imageSet.featureGraphic = res.images?.[0] ?? null;
          else if (type === "tvBanner") imageSet.tvBanner = res.images?.[0] ?? null;
          else if (type === "promoGraphic") imageSet.promoGraphic = res.images?.[0] ?? null;
          else imageSet[type] = res.images ?? [];
        } catch (e) {
          // 404 ise type bu locale için boş, devam et
        }
      }
      out.set(lang, imageSet);
    }
    return out;
  });
}
```

### 5.7.3 Upload (Raw Body)

C# kaynak: `GooglePlayAPI.cs:1100-1184` `UploadImageAsync()`.

```ts
async uploadImage(input: {
  packageName: string;
  language: string;             // Google format
  imageType: GoogleImageType;
  filePath: string;
  contentType: "image/png" | "image/jpeg";
}): Promise<{ imageId: string; sha256: string; url: string }> {
  return await this.session.withEdit(input.packageName, async (editId) => {
    const fileBuffer = await fs.readFile(input.filePath);
    const path = `/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(input.language)}/${input.imageType}`;
    // NOT: bu endpoint UPLOAD_URL'da
    const uploadUrl = `https://www.googleapis.com/upload/androidpublisher/v3/applications${path}?uploadType=media`;

    const token = await this.client.getToken();
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": input.contentType,
        "Content-Length": String(fileBuffer.length),
      },
      body: fileBuffer,
    });
    if (!res.ok) {
      throw new GoogleApiError(`Image upload failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json() as { id: string; sha256: string; url: string };
    return { imageId: data.id, sha256: data.sha256, url: data.url };
    // withEdit finally → smart commit
  });
}
```

> **DİKKAT:** Upload endpoint hostname farklı (`www.googleapis.com/upload/...`) — bunu `GoogleClient` içinde `uploadRequest()` ayrı method olarak yaz, kodu temiz tutsun.

### 5.7.4 Delete Image

```ts
async deleteImage(input: { packageName: string; language: string; imageType: GoogleImageType; imageId: string }): Promise<void> {
  await this.session.withEdit(input.packageName, async (editId) => {
    await this.client.request({
      method: "DELETE",
      path: `/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(input.language)}/${input.imageType}/${encodeURIComponent(input.imageId)}`,
    });
  });
}
```

### 5.7.5 Image Download (Auth Required)

C# kaynak: `GooglePlayAPI.cs DownloadImageAsync()`.

Google'ın döndüğü image URL **auth-required** — direkt browser'dan açılmaz. Bizim backend proxy edip thumbnail oluşturmalı:

```ts
async downloadImage(url: string): Promise<Buffer> {
  const token = await this.client.getToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new GoogleApiError(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
```

**Cache stratejisi:**
1. Pull sırasında her image download edilip object store'a kopyalan (orijinal)
2. Sharp ile thumbnail (256px webp) oluştur → object store
3. Frontend bizim signed URL ile thumbnail çeker
4. Google URL'i DB'de tut ama frontend'e gönderme

## 5.8 AAB Upload — `GoogleAabUpload.ts`

C# kaynak: `GooglePlayAPI.cs:1355-1488` + retry logic 1250-1325.

```ts
async uploadAab(input: {
  packageName: string;
  aabFilePath: string;
  onProgress?: (bytesUploaded: number, totalBytes: number) => void;
}): Promise<{ versionCode: number; sha256: string }> {
  return await this.session.withEdit(input.packageName, async (editId) => {
    const stat = await fs.stat(input.aabFilePath);
    const stream = createReadStream(input.aabFilePath);
    const uploadUrl = `https://www.googleapis.com/upload/androidpublisher/v3/applications/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}/bundles?uploadType=media`;

    const token = await this.client.getToken();
    const res = await this.fetchWithRetry({
      url: uploadUrl,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stat.size),
      },
      body: stream,
      timeoutMs: 30 * 60 * 1000, // 30 dakika
      maxRetries: 3,
      retryDelays: [5000, 10000, 20000],
      onProgress: (bytes) => input.onProgress?.(bytes, stat.size),
    });
    const data = await res.json() as { versionCode: number; sha256: string };
    return data;
  });
}
```

**Retry logic (C# `GooglePlayAPI.cs:1250-1325`):**

```ts
async fetchWithRetry(opts: FetchWithRetryOpts): Promise<Response> {
  const nonRetryablePatterns = [
    /Unauthorized/i, /Forbidden/i, /not found/i, /already exists/i,
    /^Invalid/i, /malformed/i, /401/, /403/,
  ];
  let lastErr: any;
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    try {
      const res = await fetch(opts.url, { method: opts.method, headers: opts.headers, body: opts.body, duplex: "half" });
      if (res.ok) return res;
      const text = await res.text();
      if (nonRetryablePatterns.some((p) => p.test(text))) {
        throw new GoogleApiError(`Non-retryable: ${res.status} ${text}`);
      }
      lastErr = new GoogleApiError(`HTTP ${res.status}: ${text}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < opts.maxRetries - 1) {
      await sleep(opts.retryDelays[attempt] ?? 5000);
    }
  }
  throw lastErr;
}
```

### 5.8.1 Deobfuscation Files

C# kaynak: `GooglePlayAPI.cs:1546`.

```ts
async uploadDeobfuscation(input: {
  packageName: string;
  editId: string;          // mevcut açık edit
  versionCode: number;
  fileType: "proguard" | "nativeCode";
  filePath: string;
}): Promise<void> {
  const uploadUrl = `https://www.googleapis.com/upload/androidpublisher/v3/applications/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(input.editId)}/bundles/${input.versionCode}/deobfuscationFiles/${input.fileType}?uploadType=media`;
  // POST with binary, 15 dakika timeout
}
```

## 5.9 Tracks — `GoogleTracks.ts`

C# kaynak: `GooglePlayAPI.cs:1682-1988`.

### 5.9.1 Track List

```ts
async listTracks(packageName: string): Promise<Track[]> {
  return await this.session.withEditReadOnly(packageName, async (editId) => {
    const res = await this.client.request<{ tracks: Track[] }>({
      method: "GET",
      path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/tracks`,
    });
    return res.tracks ?? [];
  });
}

export interface Track {
  track: "internal" | "alpha" | "beta" | "production";
  releases: Release[];
}

export interface Release {
  name?: string;
  versionCodes: string[];
  status: "draft" | "inProgress" | "halted" | "completed";
  userFraction?: number;                          // 0.0 - 1.0 (staged rollout)
  releaseNotes: Array<{ language: string; text: string }>;
}
```

### 5.9.2 Assign Bundle to Track

```ts
async assignBundleToTrack(input: {
  packageName: string;
  editId: string;
  trackName: "internal" | "alpha" | "beta" | "production";
  versionCodes: number[];
  status?: "draft" | "inProgress" | "completed";
  userFraction?: number;
  releaseNotes?: Array<{ language: string; text: string }>;
}): Promise<void> {
  await this.client.request({
    method: "PUT",
    path: `/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(input.editId)}/tracks/${input.trackName}`,
    body: {
      track: input.trackName,
      releases: [{
        status: input.status ?? "completed",
        versionCodes: input.versionCodes.map(String),
        ...(input.userFraction !== undefined && { userFraction: input.userFraction }),
        ...(input.releaseNotes && { releaseNotes: input.releaseNotes }),
      }],
    },
  });
}
```

## 5.10 Locale Conversion — `GoogleLocale.ts`

C# kaynak: `LocaleConverter.cs` (546 satır). **77+ Google Play locale** sabit listesi + iOS ↔ Google mapping.

```ts
// EXACT codes from Google Play Console "Add or remove languages" dialog
// LocaleConverter.cs:31-124'ten BİREBİR port
export const GOOGLE_PLAY_SUPPORTED_LANGUAGES = new Set<string>([
  "ca", "zh-HK", "zh-CN", "zh-TW", "hr", "cs-CZ", "da-DK", "nl-NL",
  "en-AU", "en-CA", "en-US", "en-IN", "en-SG", "en-ZA", "en-GB",
  "et", "fil", "fi-FI", "fr-CA", "fr-FR", "gl-ES", "ka-GE", "de-DE",
  "el-GR", "gu", "iw-IL", "hi-IN", "hu-HU", "is-IS", "id",
  "it-IT", "ja-JP", "kn-IN", "kk", "km-KH", "ko-KR", "ky-KG", "lo-LA",
  "lv", "lt", "af", "am-ET", "ar", "az-AZ", "eu-ES", "be-BY", "bn-BD",
  "bg-BG", "my-MM", "mk-MK", "ml-IN", "mr-IN", "mn-MN", "ne-NP",
  "nb-NO", "fa-IR", "pl-PL", "pt-BR", "pt-PT", "pa-IN", "ro", "ru-RU",
  "sr", "si-LK", "sk", "sl-SI", "es-419", "es-ES", "es-US", "ms-MY",
  "sw", "sv-SE", "ta-IN", "te-IN", "th", "tr-TR", "uk", "ur-PK",
  "uz-UZ", "vi", "zu-ZA", "sq",
]);

// Canonical → Google Play mapping (LocaleConverter.cs:134-252)
const TO_GOOGLE_PLAY: Record<string, string> = {
  "en": "en-US",                  // default
  "tr": "tr-TR",
  "tr-TR": "tr-TR",
  "es-MX": "es-419",              // Latin America
  "he": "iw-IL",                  // KRİTİK: Hebrew = iw-IL (eski ISO)
  "he-IL": "iw-IL",
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
  "ja": "ja-JP",
  "ko": "ko-KR",
  "pt-BR": "pt-BR",
  "pt-PT": "pt-PT",
  "ar-SA": "ar",
  "ar": "ar",
  // ... LocaleConverter.cs:134-252'den TÜM liste
};

export function toGooglePlayLocale(canonical: string): string {
  if (TO_GOOGLE_PLAY[canonical]) return TO_GOOGLE_PLAY[canonical];
  if (GOOGLE_PLAY_SUPPORTED_LANGUAGES.has(canonical)) return canonical;
  // Try base language
  const [base] = canonical.split("-");
  if (TO_GOOGLE_PLAY[base]) return TO_GOOGLE_PLAY[base];
  if (GOOGLE_PLAY_SUPPORTED_LANGUAGES.has(base)) return base;
  return canonical; // unsupported — caller decide
}

export function isGooglePlaySupported(googleLocale: string): boolean {
  return GOOGLE_PLAY_SUPPORTED_LANGUAGES.has(googleLocale);
}
```

> **TRAP — Hebrew "iw" vs "he":** Apple `he`, Google **`iw-IL`** (1989 öncesi ISO kodu, Google hala kullanıyor). Bu detay literal olarak kullanıcı dostu mesajlarda fark eder: "Hebrew (he-IL) → Google Play'de 'iw-IL' olarak gönderilecek".

## 5.12 Error Sınıflandırma

```ts
export class GoogleApiError extends Error {
  constructor(
    message: string,
    public code: "UPSTREAM_ERROR" | "CREDENTIAL_INVALID" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "VALIDATION_ERROR" | "QUOTA_EXCEEDED",
    public httpStatus: number,
    public retryable: boolean = false,
    public details?: unknown
  ) { super(message); }
}

export function classifyGoogleError(httpStatus: number, body: any, silent?: boolean): GoogleApiError {
  const message = body?.error?.message ?? body?.message ?? String(body) ?? "Unknown Google error";
  const reason = body?.error?.errors?.[0]?.reason;

  if (httpStatus === 401) return new GoogleApiError(message, "CREDENTIAL_INVALID", 401, false);
  if (httpStatus === 403) {
    if (reason === "quotaExceeded" || /quota/i.test(message)) {
      return new GoogleApiError(message, "QUOTA_EXCEEDED", 403, true);
    }
    return new GoogleApiError(message, "CREDENTIAL_INVALID", 403, false);
  }
  if (httpStatus === 404) return new GoogleApiError(message, "NOT_FOUND", 404, false);
  if (httpStatus === 409) return new GoogleApiError(message, "CONFLICT", 409, false);
  if (httpStatus === 429) return new GoogleApiError(message, "RATE_LIMITED", 429, true);
  if (httpStatus >= 500) return new GoogleApiError(message, "UPSTREAM_ERROR", httpStatus, true);
  return new GoogleApiError(message, "UPSTREAM_ERROR", httpStatus, false);
}
```

## 5.13 Edge Case'ler ve Gotcha'lar (Google)

| # | Konu | Çözüm |
|---|------|------|
| 1 | "Edit already exists" — başka bir edit açık | Redis lock + 409'da kullanıcıya "Wait 5 min" mesajı; OR list edits API ile mevcutu discard |
| 2 | Draft app commit fail aslında success | Smart commit "draft_autosave" stratejisi |
| 3 | Tek istek 30 dk → reverse proxy timeout | nginx `proxy_read_timeout 1800s` + worker'dan SSE progress |
| 4 | google-services.json package match yok | İlk client'a fallback, kullanıcıya warning |
| 5 | Locale "iw-IL" sürpriz | UI'da "Hebrew → iw-IL" explicit göster |
| 6 | Image upload Content-Type sadece png/jpeg | sniff (sharp.metadata().format) + reject |
| 7 | Service account key rotated | testConnection'da CREDENTIAL_INVALID; UI rotate prompt |
| 8 | Quota exceeded (genelde upload limiti) | RATE_LIMITED retry; kullanıcıya quota dashboard linki |
| 9 | Track userFraction 0.0-1.0 değil yanlışlıkla 0-100 | Frontend Zod validation |
| 10 | AAB 200 MB+ → reverse proxy body size limit | nginx `client_max_body_size 500m` + worker direct upload (presigned URL V1.5) |
| 11 | Edit session 24 sa timeout, lock 10 dk → uyumsuzluk | Lock TTL extend mekanizması (her API call lock'u refresh) |
| 12 | Image download URL auth-required | Backend proxy + thumbnail cache |
| 13 | UpdateMetadata fail olunca log: hangi locale | Per-locale try/catch, summary tablosu |
| 14 | Multipart vs raw upload — yanlış seçim | Sabit: hep `?uploadType=media` + raw body |

## 5.14 Test Senaryoları

1. **OAuth token cache** — 2 ardışık çağrı tek token üretti
2. **Token refresh** — TTL geçince yeniden üretildi
3. **Edit lifecycle happy path** — open → 3 listing push → commit success
4. **Edit conflict (lock)** — eşzamanlı 2 push → biri 409
5. **Smart commit — draft autosave** — fake error "Only releases with status draft" → success döner
6. **Smart commit — managed publishing required** — `changesNotSentForReview=true` ile başarılı
7. **Smart commit — auto-review** — `changesNotSentForReview must not be set` → simple commit ile retry success
8. **Locale conversion edge cases** — `he-IL` → `iw-IL`, `zh-Hans` → `zh-CN`, `tr` → `tr-TR`
9. **Unsupported locale push** — `fr-CH` (Swiss French Google Play'de yok) → unsupported listesinde, skipped
10. **Image upload happy path** — png 1080×1920 → success
11. **Image upload rejection** — icon yanlış dimensions → ValidationError
12. **AAB upload retry** — ilk 502, ikinci success
13. **AAB upload non-retryable** — 401 hemen fail
14. **google-services.json parse** — package match + first fallback testleri
15. **Track assign** — production, userFraction=0.1 staged rollout
16. **Rate limit (quota)** — 429 → exponential backoff
