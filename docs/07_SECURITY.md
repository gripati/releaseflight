# 07 — Security

> **REVİZE (Multi-Tenant + SaaS):** Multi-tenant izolasyon (RLS, cross-tenant saldırı vektörleri, tenant context spoofing önleme) detayı [`10_MULTI_TENANT.md`](./10_MULTI_TENANT.md) 10.9'da. SaaS-spesifik güvenlik (signup brute-force, Stripe webhook signature, platform admin access) [`11_SELF_HOST_TO_SAAS.md`](./11_SELF_HOST_TO_SAAS.md)'de. Tenant isolation test suite ZORUNLULUĞU [`14_QA_TESTING.md`](./14_QA_TESTING.md) 14.5'te.

## 7.-1 Multi-Tenant Security Additions (özet)

Standart güvenlik kontrolleri **tenant-aware** olmalı:

| Kontrol | Tenant-aware uygulama |
|---------|----------------------|
| Rate limit | Per-user + per-tenant + per-tenant-per-action sınırları ayrı |
| Audit log | `tenantId` her event'te zorunlu; cross-tenant view sadece PlatformAdmin |
| Session | `activeTenantId` zorunlu; tenant change re-validation gerektirir |
| Credential | `tenants/<id>/<credId>` path prefix'i ile izole |
| Object storage | Aynı şekilde tenant prefix; signed URL sadece kendi tenant scope |
| Logs | Pino log enrichment ile `tenantId` otomatik eklenir |
| Backup | Per-tenant restore mümkün olmalı (tenant lifecycle için) |
| Test | Cross-tenant IDOR suite her endpoint için zorunlu (CI gate) |

Tehdit modeli **8 cross-tenant saldırı vektörü** [`10_MULTI_TENANT.md`](./10_MULTI_TENANT.md) 10.9'da; mitigation'lar açık.

## 7.0 Tehdit Modeli (Threat Model)

API kimlik bilgilerini bir SaaS-tarzı platformda yönetmek **tek başına** bu projenin en kritik yönü. Yanlış yapılırsa: bir saldırgan Apple/Google credential'ını alıp yetkisiz build push edebilir, store sayfasını değiştirebilir, hatta uygulamayı kaldırabilir.

Mevcut Unity paketinde kimlik bilgileri **EditorPrefs**'te base64 obfuscation ile tutuluyor (plaintext'e neredeyse eşit). Web tarafında **bunu kabul edilemez**. Bu doküman güvenlik baseline'ını tanımlar.

## 7.0 Tehdit Modeli (Threat Model)

### Saldırgan Profilleri

| Aktör | Yetenek | Hedef |
|-------|---------|-------|
| **Network sniffer** | TLS olmayan trafiği okur | Credential, oturum cookie'si |
| **XSS injection** | Frontend'de script çalıştırır | Cookie hijack, credential export |
| **CSRF** | Kullanıcı browser'ından istek yapar | Yetkisiz push/delete |
| **Compromised DevOps** | Server'a SSH erişim | Disk üzerindeki secret, env değişkenler |
| **Malicious dependency** | npm/pnpm tedarik zinciri | Build-time leak |
| **Insider** | Geçerli login, kötü niyet | İzinsiz app delete, credential kopyala |
| **Apple/Google adı taklit** | Phishing | "Yeni .p8 yükleyin" tuzak |

### Varlık Sınıflandırması

| Varlık | Hassasiyet | Sızıntı sonucu |
|--------|-----------|----------------|
| Apple `.p8` private key | **CRITICAL** | Tam App Store kontrolü → uygulama silinebilir, sahte build push edilebilir |
| Google service account JSON | **CRITICAL** | Aynı, Google Play için |
| User password hash (Argon2id) | HIGH | Brute force ile login |
| Session cookie | HIGH | Hesap takeover |
| App metadata (description, vs) | MEDIUM | Public bilgi ama bütünlük önemli |
| Screenshot binary | LOW | Public asset |
| Audit log | MEDIUM | Sızıntı analiz için kritik |

## 7.1 Credential Storage (EN KRİTİK)

### 7.1.1 Layer'lar

```
┌─────────────────────────────────────────────────────────────┐
│  DB (Postgres)                                              │
│  Credential.secretRef = "aws-sm:///gp/credentials/<uuid>"   │
│  → SADECE referans, ham veri YOK                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  SecretProvider (abstraction)                               │
│  ├─ FilesystemSecretProvider  (dev, küçük self-host)        │
│  ├─ AwsSecretsManagerProvider (prod)                        │
│  └─ HashiCorpVaultProvider    (enterprise)                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Backing store                                              │
│  • AWS Secrets Manager (KMS encrypted at rest)              │
│  • Vault (transit encryption + audit)                       │
│  • Disk (mode 600, encrypted FS)                            │
└─────────────────────────────────────────────────────────────┘
```

### 7.1.2 FilesystemSecretProvider (Dev)

```
~/.marquee/secrets/             # mode 700, owned by marquee user
├── meta.json                         # {credId → {kind, kid, projectId, ...}}
├── <credId>.p8                       # mode 600 (Apple)
```

**Disk encryption:** macOS FileVault, Linux LUKS — OS-level. Dev için yeterli.

**Docker volume:**
```yaml
volumes:
  - type: bind
    source: ${HOME}/.marquee/secrets
    target: /secrets
    read_only: true       # write-once on host
```

`SecretProvider` interface:
```ts
export interface SecretProvider {
  put(credentialId: string, kind: CredentialKind, material: Buffer): Promise<string>; // returns secretRef
  get(secretRef: string): Promise<Buffer>;
  delete(secretRef: string): Promise<void>;
}
```

### 7.1.3 AwsSecretsManagerProvider (Prod)

```ts
async get(secretRef: string): Promise<Buffer> {
  // secretRef: "aws-sm:///gp/credentials/abc-uuid"
  const arn = parseArn(secretRef);
  const cmd = new GetSecretValueCommand({ SecretId: arn });
  const res = await secretsManagerClient.send(cmd);
  return Buffer.from(res.SecretString!, "utf-8");
}
```

**IAM Policy (least privilege):**
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": "arn:aws:secretsmanager:us-east-1:*:secret:gp/credentials/*"
  }]
}
```

**Rotation:** AWS Secrets Manager rotation Lambda — kullanıcı UI'dan `[Rotate]` tıklayınca yeni dosya upload → Lambda eski versiyonu pending olarak işaretler → 24 saat sonra kalıcı silinir.

### 7.1.4 Yasaklar (NEVER)

- ❌ **Credential'ı DB'de plaintext tutma**
- ❌ **Credential'ı log'a yazma** (LogRedactor zorunlu, bkz. 7.5)
- ❌ **Credential'ı response body'sinde dönme** (UI sadece kayıt referansı görür)
- ❌ **Credential'ı git'e commitleme** (.gitignore + commit-msg hook ile blokla)
- ❌ **Credential'ı env değişkende uzun süre tutma** (sadece startup time'da SecretProvider config, sonra unset)
- ❌ **Browser'da `.p8` decode etmeye çalışma** — backend'den geçmeli
- ❌ **DB backup'larda kolay erişilir tutma** — backup şifreli (KMS)

## 7.2 Authentication

### 7.2.1 V1 — Lokal Tek-User

Boot'ta `OWNER_EMAIL` + `OWNER_PASSWORD` env değişkenleri zorunlu (Argon2id hash) → ilk login sonrası UI'dan password change.

```ts
// packages/db/src/seed.ts
await prisma.user.upsert({
  where: { email: process.env.OWNER_EMAIL },
  create: {
    email: process.env.OWNER_EMAIL,
    passwordHash: await argon2.hash(process.env.OWNER_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 65536,    // 64 MB
      timeCost: 3,
      parallelism: 4,
    }),
    role: "OWNER",
  },
  update: {},
});
```

### 7.2.2 V2 — Multi-User + SSO

- **next-auth v5 / Better-Auth** ile:
  - Email + password (Argon2id)
  - GitHub OAuth
  - Google OAuth (org SSO)
  - SAML (enterprise)
- Invite link flow: org owner → invite by email → 24h valid token → user sets password
- Password rules: 12+ chars, zxcvbn score ≥ 3 (≥ "fair")

### 7.2.3 Session Yönetimi

- **httpOnly cookie** (`gp_session`), `Secure` (production), `SameSite=Lax`
- Cookie içeriği: `sessionId` (opaque uuid), value DB'de `Session.token` (hash karşılaştırma)
- Session expiry: 7 gün (sliding window — her aktif kullanım rolls)
- Concurrent session limit: 5 (yenisi en eskiyi devirir)
- "Sign out everywhere" button → `Session.deleteMany({ where: { userId } })`

### 7.2.4 CSRF Koruması

- **double-submit cookie**: `gp_csrf` (non-httpOnly) + her mutating request header `X-CSRF-Token` aynısı olmalı
- SameSite=Lax zaten çoğunu engeller; ek güvenlik için zorunlu
- GET endpoint'ler CSRF'siz; sadece POST/PUT/PATCH/DELETE

### 7.2.5 Rate Limiting

| Endpoint | Limit | Notlar |
|----------|-------|--------|
| `POST /auth/login` | 5/dakika per IP + per email | Brute force |
| `POST /credentials` | 10/saat per user | Spam credential abuse |
| `POST /credentials/:id/test` | 10/dakika per user | Spam test |
| `POST /apps/:id/metadata/push` | 5/dakika per app | Apple/Google rate limit'i koru |
| `POST /screenshots/upload` | 60/dakika per user | Bulk import için yüksek |
| Genel | 600/dakika per user | DoS koruma |

**Backend:** Redis sliding window (`@upstash/ratelimit` benzeri).

**429 response:** `Retry-After: 30` header + JSON.

## 7.3 Authorization (RBAC)

### 7.3.1 Roller

| Role | Görür | Düzenler | Push edebilir | Credential mgmt | User mgmt |
|------|-------|----------|---------------|-----------------|-----------|
| `OWNER` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `ADMIN` | ✓ | ✓ | ✓ | ✓ | invite only |
| `EDITOR` | ✓ | ✓ | ✓ | view only | — |
| `VIEWER` | ✓ | — | — | view only | — |

### 7.3.2 Implementasyon

Her API endpoint için decorator/middleware:

```ts
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession(req);
  const app = await requireApp(params.id, session.orgId);
  requireRole(session, ["OWNER", "ADMIN", "EDITOR"]);    // EDITOR push edebilir
  // ...
}
```

`requireRole` audit'a yazılır (FORBIDDEN attempt).

### 7.3.3 Resource-Level Authorization

V2'de **per-app permissions** — bir kullanıcının sadece belirli app'lere erişimi olur. Şimdilik org-level yeter.

## 7.4 Network Security

### 7.4.1 TLS

- **TLS 1.3** (TLS 1.2 fallback)
- Sertifika: Let's Encrypt (cert-manager + nginx-acme veya Caddy)
- HSTS: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- Cipher suites: only AEAD (no RC4, no 3DES)
- OCSP stapling: enabled

### 7.4.2 HTTP Security Headers

`next.config.mjs`:
```js
async headers() {
  return [{
    source: "/(.*)",
    headers: [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "X-XSS-Protection", value: "0" }, // CSP already covers
      { key: "Content-Security-Policy", value: cspHeader },
    ],
  }];
}
```

**CSP:**
```
default-src 'self';
script-src 'self' 'nonce-{NONCE}';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://*.apple.com https://*.googleusercontent.com;
connect-src 'self';
font-src 'self' data:;
frame-ancestors 'none';
form-action 'self';
base-uri 'self';
upgrade-insecure-requests;
report-uri /api/v1/csp-report;
```

> Tüm script inline'ları nonce ile (Next.js App Router built-in support).

### 7.4.3 CORS

- **API tek origin'e izin**: production frontend domain'i (`https://gp.example.com`)
- Credential'lı request (`credentials: true`) → wildcard yasak
- Browser-API only; programmatic için PAT (V2)

### 7.4.4 Egress Whitelist

Self-host setup'ta, backend'in dış dünyaya hangi domain'lere bağlanabileceğini sınırla (network policy / firewall):

```
ALLOW api.appstoreconnect.apple.com:443
ALLOW *.s3.amazonaws.com:443           # Apple uploadOperations
ALLOW androidpublisher.googleapis.com:443
ALLOW www.googleapis.com:443           # upload
ALLOW oauth2.googleapis.com:443
DENY *
```

Bu C2 (command & control) ve data exfiltration'ı önler.

## 7.5 Log Redaction

C# kaynak: `SecurityHelpers.cs:168-224` `LogRedactor.Redact()`.

Web tarafında **MUTLAKA** her log entry redactor'dan geçmeli:

```ts
const REDACT_PATTERNS = [
  {
    name: "PEM private key",
    regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g,
    replacement: "<REDACTED:PRIVATE_KEY>",
  },
  {
    name: "JSON private_key field",
    regex: /"private_key"\s*:\s*"[^"]+"/g,
    replacement: '"private_key":"<REDACTED>"',
  },
  {
    name: "JWT token",
    regex: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g,
    replacement: "<REDACTED:JWT>",
  },
  {
    name: "Bearer token",
    regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: "Bearer <REDACTED>",
  },
  {
    name: "GCP access token",
    regex: /ya29\.[A-Za-z0-9\-_]+/g,
    replacement: "<REDACTED:GCP_TOKEN>",
  },
  {
    name: "Email",
    regex: /([a-zA-Z0-9._%+-])([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    replacement: (_, first, mid, domain) => `${first}***${mid.slice(-1)}@${domain}`,
  },
  {
    name: "Apple Issuer ID",
    regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    replacement: (uuid) => uuid.slice(0, 8) + "-***",
  },
];

export function redact(input: string): string {
  let out = input;
  for (const p of REDACT_PATTERNS) {
    out = out.replace(p.regex, p.replacement as any);
  }
  return out;
}
```

**Pino integration:**
```ts
const logger = pino({
  redact: {
    paths: [
      "*.password", "*.passwordHash", "*.privateKey", "*.private_key",
      "*.secretRef", "credential.material", "headers.authorization",
      "headers.cookie",
    ],
    censor: "<REDACTED>",
  },
  formatters: {
    log: (object) => {
      // Stringify, redact patterns, re-parse
      const str = JSON.stringify(object);
      return JSON.parse(redact(str));
    },
  },
});
```

> **Performans:** Redact regex'leri her log entry'sinde çalışır. Yüksek throughput log'larda dampen → sadece WARN+ seviyesinde redact, INFO'da çoğunlukla guvenli mesajlar.

## 7.6 Input Validation

### 7.6.1 Zod Everywhere

Her endpoint Zod schema kullanır (bkz. `02_BACKEND_API_SPEC.md`). Body, query, params — hepsi schema ile parse.

```ts
const schema = z.object({
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2,4})?$/),
  description: z.string().max(4000),
});

const body = schema.parse(await req.json()); // throws → caught by error handler → 400
```

### 7.6.2 Path Traversal

Tüm dosya path'leri normalize + jail check:

```ts
import path from "node:path";

function safePath(base: string, userInput: string): string {
  const resolved = path.resolve(base, userInput);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) {
    throw new ValidationError("Path traversal attempt");
  }
  return resolved;
}
```

### 7.6.3 Shell Injection

`SecurityHelpers.cs:22-72` `ShellSafe.EscapeArg()` port:

- **Asla `exec(string)` kullanma** — daima `execFile(cmd, [...args])` (Node)
- Subprocess kullanırken `child_process.spawn(cmd, args, { shell: false })`
- Argümanlar listede; string concat yok

V1'de subprocess kullanımı **YOK** (mevcut Unity kodundaki openssl Web'de native crypto ile değiştirildi). V2 build tool entegrasyonu eklenirse bu konu önemli.

### 7.6.4 ReDoS (Regex DoS)

Kullanıcı input'una uygulanan regex'lerin **catastrophic backtracking** olmadığını test et (`safe-regex` npm). Özellikle email/URL/locale validation.

### 7.6.5 SSRF (Server-Side Request Forgery)

Web app'in dış URL fetch ettiği yerler:
1. Apple/Google API (whitelisted, sabit)
2. **Marketing URL / Support URL preview** (kullanıcı verir) → SSRF riski

Eğer URL preview/fetch yapacaksak:
- DNS resolution sonrası IP whitelist (no private IP: 10.x, 172.16.x, 192.168.x, 127.x, ::1)
- HTTP redirect limit 3
- Timeout 5s
- Response size limit 1 MB

Şimdilik **URL preview YOK** → SSRF risk minimal.

### 7.6.6 File Upload Validation

```ts
const file = formData.get("file") as File;

// 1. Size limit (multer/Next.js built-in)
if (file.size > 8 * 1024 * 1024) throw new ValidationError("FILE_TOO_LARGE");

// 2. MIME sniffing (magic bytes), NOT trust extension
const buf = Buffer.from(await file.arrayBuffer());
const fileType = await fileTypeFromBuffer(buf);
if (!["image/png", "image/jpeg"].includes(fileType?.mime ?? "")) {
  throw new ValidationError("INVALID_FORMAT");
}

// 3. Image decode (sharp) — catches malformed images / decompression bombs
const meta = await sharp(buf, { limitInputPixels: 50_000_000 }).metadata();
if (meta.width! * meta.height! > 16_000_000) {
  throw new ValidationError("Image too large pixel count");
}
```

> **Decompression bomb:** Sharp `limitInputPixels` ile 50 MP limit. PNG'ler genelde 1284×2778 = 3.5 MP; bu cap güvenli.

## 7.7 Audit Logging

Her **mutating** action (state-changing) audit'a yazılır:

```ts
await audit({
  orgId, userId, appId,
  action: "metadata.push",
  target: `app:${appId}`,
  diff: { en_US: { description: { from: "old", to: "new" } } }, // redacted
  outcome: "SUCCESS",
  requestId, ipAddress, userAgent,
});
```

**Sensitive diff redaction:** Credential change → diff'te `secretRef` yok, sadece `{kind: APPLE, name: "Apple Prod", rotated: true}`.

**Retention:** 1 yıl active query, 5 yıl Glacier (legal). V2: GDPR right-to-be-forgotten için soft-delete.

**Tamper resistance:** V2'de hash chain (her event'in `hash` field'ı, `prevHash` + payload) — auditor güvensiz olsa bile değişiklikler tespit edilir.

## 7.8 Backup ve Disaster Recovery

| Komponent | Backup | RPO | RTO |
|-----------|--------|-----|-----|
| Postgres | Günlük full + 5dk WAL ship → S3 | 5 dk | 30 dk |
| Object store | S3 versioning + cross-region | 1 sa | 1 sa |
| Secrets | AWS Secrets Manager built-in versioning | 0 | 5 dk |
| Audit log | Aynı Postgres → backup | 5 dk | 30 dk |
| Redis (cache) | RDB snapshot saat başı | 1 sa | 5 dk |

**Restore drill:** Ayda bir, staging'de tam restore + smoke test. Manuel checklist `infra/disaster-recovery.md`.

## 7.9 Dependency Security

### 7.9.1 SCA (Software Composition Analysis)

- **GitHub Dependabot** — günlük security update PR'ları (otomatik merge minor patch'ler)
- **Snyk** — pnpm install öncesi `snyk test`
- **npm audit** CI step (HIGH+ → fail build)
- **socket.dev** — yeni dependency eklemeden önce risk skoru (V1.5)

### 7.9.2 Lock Files

- `pnpm-lock.yaml` commit edilir
- CI `pnpm install --frozen-lockfile` (drift'i engelle)
- `pnpm audit --prod` her PR

### 7.9.3 Supply Chain

- **Subresource Integrity** — eğer CDN'den asset çekiyorsak `integrity=sha384-...`
- **Repository signing** — git tag'leri GPG signed (release süreci)
- **SLSA Level 2** hedefi (V2)

## 7.10 Container Security

### 7.10.1 Dockerfile Hardening

```dockerfile
# Multi-stage, distroless final
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++   # build için
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM gcr.io/distroless/nodejs20-debian12 AS runtime
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
USER 1000
EXPOSE 3000
CMD ["server.js"]
```

- **Non-root user** (UID 1000)
- **Distroless** (no shell, minimal attack surface)
- **Multi-stage** (build deps stripped)
- **Image scan** (Trivy / Snyk container) CI'da

### 7.10.2 docker-compose Security

```yaml
services:
  web:
    image: marquee-web:latest
    read_only: true                  # FS read-only
    tmpfs:
      - /tmp
      - /app/.next/cache
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    volumes:
      - type: bind
        source: ${HOME}/.marquee/secrets
        target: /secrets
        read_only: true
    environment:
      NODE_ENV: production
    secrets:
      - source: db_password
        target: /run/secrets/db_password
```

## 7.11 Incident Response

### 7.11.1 Credential Leak Detected

1. **Detect** — Sızıntı bilgisi nereden geldi (user report, GitHub secret scanning, AWS GuardDuty)
2. **Contain** — İlgili `Credential` `isActive=false` immediate
3. **Rotate** — Apple/Google portal'den yeni .p8 / new service account key
4. **Update** — UI'dan yeni credential upload
5. **Audit** — Sızıntı tarihinden bu yana yapılan tüm push'lar incele
6. **Notify** — Apple/Google'a "compromised" report (Apple form, Google issue tracker)
7. **Post-mortem** — Nasıl sızdı, ne korumayı eklemeliyiz

### 7.11.2 DB Breach

1. Şifreleri force-reset (tüm session'ları invalid'le)
2. Backup'tan en son temiz noktayı restore
3. Audit log'dan saldırgan IP/timestamp tespiti
4. Hangi credentials ham olarak DB'den okunabilirdi → tümünü rotate

## 7.12 Compliance (Bilgi Notu)

V1 hedefi self-host olduğu için compliance müşteri sorumluluğu. V2 SaaS olunca:

- **GDPR** — kullanıcı data'sı: right-to-export, right-to-be-forgotten endpoint'leri
- **SOC 2 Type 2** — V2 hedef (12 ay süreç, audit firması)
- **App Store Connect API Terms** — Apple'ın API kullanımı sözleşmesine uygunluk
- **Google Play Developer API Terms** — aynı

## 7.13 Penetration Testing

- **MVP öncesi** — internal pentest (OWASP ZAP automated)
- **V1.5** — external pentest (3rd party, ~$5-10k bütçe)
- **V2** — annual recurring + bug bounty (HackerOne / Bugcrowd)

## 7.14 Güvenlik Checklist (Release-Öncesi)

Her release öncesi:

- [ ] `pnpm audit` HIGH+ vulnerability yok
- [ ] Yeni endpoint Zod validate + RBAC kontrolü
- [ ] Yeni log statement redact'ten geçiyor
- [ ] Yeni credential field SecretProvider üzerinden
- [ ] Frontend asset'ler `nonce` kullanıyor (CSP)
- [ ] Migration backup-safe (down-script var)
- [ ] Trivy container scan clean
- [ ] Playwright e2e + auth flow geçti
- [ ] Restore drill staging'de başarılı (aylık)
- [ ] Audit log her CRUD action için yazıldı (smoke test)

## 7.15 Açık Güvenlik Soruları

| Soru | Önerilen default | Karar |
|------|------------------|-------|
| MFA zorunlu mu? | OWNER/ADMIN için TOTP zorunlu V1.5 | Tek user için overkill, V2 |
| Hardware token (WebAuthn)? | Opsiyonel V2 | Yüksek-değer org için |
| Session bind to IP? | Hayır (mobile network değiştirir) | Suspicious activity → re-auth prompt |
| API key (PAT) for CI? | V2 | Kullanıcı CI'dan push isterse |
| BYOK (bring your own key) for at-rest encryption? | V2 enterprise | Compliance gerektirirse |
| Network egress proxy? | Self-host opsiyonel | Enterprise için |
