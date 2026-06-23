# 06 — Frontend UI/UX Design (Page-by-Page)

Bu doküman `12_DESIGN_SYSTEM.md`'in design token'larını ve `frontend-design` skill metodolojisini **sayfa sayfa** uygulanmış spec olarak içerir. Her sayfanın wireframe'i, etkileşim akışı, motion, edge case'leri ve a11y notlarıyla.

> **Önce oku:** `12_DESIGN_SYSTEM.md` — token'lar, component'ler ve "Editorial-Technical Hybrid" aesthetic direction'ı oradan.

## 6.0 Information Architecture Özeti

```
PUBLIC (SaaS only)
├── /                           Landing / marketing
├── /pricing
├── /docs/*
├── /changelog
├── /login
├── /signup                     (SaaS only)
├── /forgot-password
├── /verify-email/[token]
└── /accept-invite/[token]

DASHBOARD (auth required, tenant-scoped)
├── /t/[tenantSlug]/dashboard
├── /t/[tenantSlug]/apps
│   ├── /apps/[appId]/overview
│   ├── /apps/[appId]/metadata
│   ├── /apps/[appId]/screenshots
│   ├── /apps/[appId]/previews        (iOS only)
│   ├── /apps/[appId]/builds          (V1.5)
│   ├── /apps/[appId]/submission      (V1.5)
│   └── /apps/[appId]/history
├── /t/[tenantSlug]/credentials
├── /t/[tenantSlug]/audit
├── /t/[tenantSlug]/jobs
├── /t/[tenantSlug]/team              (members, invitations)
├── /t/[tenantSlug]/settings
│   ├── /settings/profile             (per-user)
│   ├── /settings/tenant              (tenant info, slug, name)
│   ├── /settings/preferences         (theme, density, language)
│   ├── /settings/billing             (SaaS only, V2)
│   ├── /settings/api-tokens          (V2)
│   └── /settings/danger              (delete tenant)
└── /account/tenants                  (user'ın tüm tenants — switcher)

ADMIN (PlatformAdmin only, SaaS)
└── /admin/*                          (tenants, audit, jobs, feature flags)
```

## 6.1 Global Frame (Layout Shell)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOPBAR — 56px height, paper bg + hairline bottom                             │
│ [Logo Fraunces ital]  [Tenant ▾]  ─────────  [Cmd+K] [Jobs⊙2] [Theme] [👤▾] │
├────────────────┬─────────────────────────────────────────────────────────────┤
│ SIDEBAR        │  CONTENT AREA — max-w-1440 mx-auto px-12 py-10              │
│ 240px fixed    │                                                             │
│ paper bg       │  Page header (Fraunces title 36px + breadcrumb caption)     │
│ + hairline R   │  ─── hairline divider ───                                   │
│                │                                                             │
│ • Dashboard    │  Content (page-specific)                                    │
│ • Apps  [+]    │                                                             │
│   ├ iOS        │                                                             │
│   ├ Android    │                                                             │
│ • Credentials  │                                                             │
│ • Jobs (2)     │                                                             │
│ • Audit        │                                                             │
│ • Team         │                                                             │
│ ─────          │                                                             │
│ • Settings     │                                                             │
│                │                                                             │
│ [Status: ✓]    │                                                             │
└────────────────┴─────────────────────────────────────────────────────────────┘
```

**Tasarım notları:**
- Topbar **ince** (56px) — content'in nefes alma alanını çal/dolduran kalın navbar'lar yasak
- Logo Fraunces italic (`opsz: 36`, `wght: 400`, `SOFT: 50`) — magazine masthead hissi
- Tenant switcher topbar'da (mevcut tenant gösterilir, dropdown ile değiş); self-host'ta gizli
- Sidebar 240px sabit; mobile'da kaybolur, hamburger menu V2
- "Status" badge (`Status: ✓ All systems normal`) sidebar bottom — self-host'ta sistem sağlığı, SaaS'ta status page link
- Page header: Fraunces 36px title + Geist caption (breadcrumb / context)
- Content max-w 1440 — büyük ekranlarda center, asla full-width sprawl

## 6.2 Login (`/login`)

**Aesthetic kasıt:** Magazine cover page — büyük tipografik display + sade form.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   ┌────────────────────────────────┐    ┌────────────────────────────────┐  │
│   │  LEFT (60%)                    │    │  RIGHT (40%)                   │  │
│   │  paper texture, ink draw       │    │  surface-elevated card         │  │
│   │                                │    │                                │  │
│   │  ─ ESTABLISHED 2026 ─          │    │  WELCOME BACK                  │  │
│   │                                │    │                                │  │
│   │                                │    │  Email                         │  │
│   │  Publish                       │    │  ┌──────────────────────────┐  │  │
│   │  Anywhere.                     │    │  │                          │  │  │
│   │                                │    │  └──────────────────────────┘  │  │
│   │  Manage everything             │    │                                │  │
│   │  Apple, Google                 │    │  Password                      │  │
│   │   from             │    │  ┌──────────────────────────┐  │  │
│   │  one editorial dashboard.      │    │  │                          │  │  │
│   │                                │    │  └──────────────────────────┘  │  │
│   │  ▭▭▭▭▭▭▭ (signal accent bar)   │    │                                │  │
│   │                                │    │  [Forgot?]                     │  │
│   │  vol. 1 · issue 5              │    │                                │  │
│   │                                │    │  ┌──────────────────────────┐  │  │
│   │                                │    │  │   →  SIGN IN             │  │  │
│   │                                │    │  └──────────────────────────┘  │  │
│   │                                │    │                                │  │
│   │                                │    │  ── or ──                      │  │
│   │                                │    │                                │  │
│   │                                │    │  [☆ Continue with GitHub]      │  │
│   │                                │    │  [♦ Continue with Google]      │  │
│   │                                │    │                                │  │
│   │                                │    │  No account? · Start trial     │  │
│   └────────────────────────────────┘    └────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Komponent detayları:**
- "Publish Anywhere." — `--type-display` (clamp 56-84px), Fraunces italic, `--ink-primary`
- Signal accent bar: 8px height × 120px, `--signal` color, ink-stamp tilt -2deg
- "vol. 1 · issue 5" — periodical reference, `--type-mono-xs`, `--ink-tertiary`
- Form: inputs `h-12`, `--radius-xs`, focus → signal ring
- "SIGN IN" button → `--type-label` + `letter-spacing: 0.08em`, primary variant
- Sign up link → SaaS modda görünür; self-host modda gizli

**Motion:**
- Page-load: left side text **word-by-word reveal** (60ms stagger), right side fade-in (240ms delay)
- Signal accent bar: width 0 → 120px transition 600ms eased
- Form field focus: hairline → 1.5px signal ring with slight scale 1.01 (160ms)

**Edge case'ler:**
- Invalid credentials: form shake (3 shakes × 60ms each, `[-4px, 4px, 0]`) + inline error
- Account locked: "Too many attempts" toast + 60s countdown timer
- Email unverified (SaaS): redirect `/verify-email-prompt`
- Successful login + tenant switcher needed (multi-tenant): redirect `/account/tenants`

## 6.3 Tenant Picker (`/account/tenants`)

Multi-tenant kullanıcının login sonrası landed tenant seçimi:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   Choose a workspace                                                         │
│   Pick where you'd like to continue today                                    │
│   ─────────────────────────────────────────                                  │
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────────┐ │
│   │ Aa  Gripati Studio                                                  →  │ │
│   │     gripati  •  Owner  •  12 apps  •  Pro plan                         │ │
│   │     last active 12 min ago                                             │ │
│   └────────────────────────────────────────────────────────────────────────┘ │
│   ┌────────────────────────────────────────────────────────────────────────┐ │
│   │ Aa  Acme Mobile                                                     →  │ │
│   │     acme  •  Editor  •  5 apps  •  Free trial (3 days left)            │ │
│   └────────────────────────────────────────────────────────────────────────┘ │
│   ┌────────────────────────────────────────────────────────────────────────┐ │
│   │ Aa  Freelance Clients                                               →  │ │
│   │     freelance  •  Owner  •  3 apps  •  Free                            │ │
│   └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│   ─── or ───                                                                 │
│                                                                              │
│   [+ Create new workspace]    Set default workspace [☐]                      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Detaylar:**
- Tenant avatar = ilk harfin Fraunces display version'ı (initial-based, 40px circle)
- Role pill: `--type-overline`, color = role'e göre (Owner = `--signal`, Editor = `--status-info`)
- Trial countdown SaaS only; Self-host'ta gizli
- "Set as default" checkbox → `User.defaultTenantId` set
- Cmd+1, Cmd+2, ... shortcut'ları (first 9 tenant)

## 6.4 Dashboard (`/t/[slug]/dashboard`)

**Aesthetic kasıt:** Newspaper morning edition — primary "Active Jobs" headline + secondary stats sidebar.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Dashboard                                          MAY 17, 2026 · 14:23 GMT │
│  Gripati Studio                                                              │
│  ════════════════════════════════════════════════════════════════════════    │
│                                                                              │
│  ── HEADLINE ──────────────────────────────────────────────                  │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  ACTIVE NOW                                                          │    │
│  │  ════════════                                                        │    │
│  │  Pushing metadata for Cyber Clash                                    │    │
│  │  12 of 35 locales · started 2 minutes ago                            │    │
│  │                                                                      │    │
│  │  ▓▓▓▓▓▓░░░░░░░░░░░░░░ 34%                                            │    │
│  │  Current: tr (in progress) · ETA 1 min                               │    │
│  │  Last: ja • Created appStoreVersionLocalization                      │    │
│  │                                                                      │    │
│  │  [View progress] [Cancel]                                            │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ── AT A GLANCE ─────────────────────  ── LATEST ACTIVITY ─────────────────  │
│  ┌─────────┬─────────┬─────────┐       Sun · You · pushed 3 locales         │
│  │   12    │   35    │   142   │       Sun · You · uploaded 5 screenshots   │
│  │  apps   │  locales│ screens │       Sat · System · Apple status changed  │
│  │  ───    │  ───    │  ───    │       Sat · Sarah · accepted invitation    │
│  │  +2 wk  │  +5 wk  │  +12 wk │       Fri · You · created Word Stack       │
│  └─────────┴─────────┴─────────┘                                             │
│                                                                              │
│  ── ATTENTION REQUIRED ─────────────────────────────────────────────────────  │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ ⊙ DIRTY     Word Stack iOS · 3 locales need push (en-US, tr, ja)     │    │
│  │ ⊙ MISSING   Cyber Clash Android · feature graphic not uploaded       │    │
│  │ ⊙ EXPIRING  Apple credential rotates in 90 days                      │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ── QUICK ACTIONS ──────────────────                                         │
│  [+ Connect app] [↑ Import master JSON] [⌘ Push everything dirty]           │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Detaylar:**
- "MAY 17, 2026 · 14:23 GMT" — mono uppercase, masthead date format
- "ACTIVE NOW" hero card: paper-textured, signal-tint background, large display title
- Stats grid 3 col: büyük tabular number (Fraunces 48px), caption (Geist xs), micro-trend (+2 wk ile signal accent)
- "ATTENTION REQUIRED" list: state dot + action labels, hover → action link
- Quick Actions: ghost button bar

**Motion:**
- Page-load orchestration: headline first (0ms), stats (120ms), activity (240ms), attention (360ms), actions (480ms)
- ACTIVE NOW card pulse: state dot subtle ping animation (2s loop)
- Progress bar fill: SSE-driven smooth transition

**Empty state (no apps yet):**
```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│                    ━━━━ EDITION ZERO ━━━━                                   │
│                                                                              │
│                Let's publish your                                            │
│                first story.                                                  │
│                                                                              │
│              Connect an iOS or Android app to                                │
│              start managing metadata, screenshots                            │
│              and submissions across stores.                                  │
│                                                                              │
│                ▭▭▭▭▭▭▭▭ (signal accent line)                                 │
│                                                                              │
│                ┌──────────────────────────────┐                              │
│                │  →  CONNECT FIRST APP        │                              │
│                └──────────────────────────────┘                              │
│                                                                              │
│              Or [import from existing master JSON]                           │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

Empty state title: typewriter reveal (one letter per 40ms) — frontend-design'ın "memorable detail" prensibi.

## 6.5 Apps List (`/t/[slug]/apps`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Apps                                                                        │
│  12 connected · 3 with unpushed edits             [+ Connect app]            │
│  ──────────────────────────────────────────────                              │
│                                                                              │
│  [🔍 search by name or bundle id...]  [Platform ▾] [Status ▾] [Sort ▾]      │
│                                                                              │
│  ── APPS ────────────────────────────────────────────────────────────────    │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  ●  Cyber Clash                                              [⋮]     │    │
│  │  iOS                                                                 │    │
│  │  com.gripati.cyberclash · v1.2.3                                     │    │
│  │  READY_FOR_SALE · 35 locales · last push 2h ago                      │    │
│  │  ⊙ 3 unpushed edits                                                  │    │
│  │  ──────                                                              │    │
│  │  [Open →]                                                            │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  ●  Cyber Clash                                              [⋮]     │    │
│  │  Android                                                             │    │
│  │  com.gripati.cyberclash · vCode 14                                   │    │
│  │  Production · 24 locales · all synced                                │    │
│  │  ──────                                                              │    │
│  │  [Open →]                                                            │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  ●  Word Stack Solitaire                                     [⋮]     │    │
│  │  iOS                                                                 │    │
│  │  com.emrepehlevan.wordstack · v2.0.1                                 │    │
│  │  ⚠ Credential test failed 12 minutes ago                             │    │
│  │  ──────                                                              │    │
│  │  [Fix credential →]                                                  │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Detaylar:**
- Her card: ●(state dot) + ad (Fraunces heading) + platform badge mono
- Bundle ID monospace, IDs grayed
- Sub-rows: status, count metadata; state alerts (⊙ dirty, ⚠ error) signal-toned
- "──────" hairline divider içeride
- Card hover: y: -2px + shadow-elevated transition

## 6.6 Connect App Wizard (3 Adımlı Sheet)

`Sheet` (right drawer 560px). Adım gösterimi üstte progress.

**Step 1 — Platform:**
```
┌──────────────────────────────────────────────┐
│  Connect a new app                      [✕]  │
│  Step 1 of 3 · Choose platform               │
│  ●━━○━━○                                     │
│  ────────────────────────                    │
│                                              │
│  ┌──────────────┐  ┌──────────────┐         │
│  │              │  │              │         │
│  │  Aa          │  │  Aa          │         │
│  │              │  │              │         │
│  │  iOS         │  │  Android     │         │
│  │  App Store   │  │  Google Play │         │
│  │              │  │              │         │
│  │  .p8 + IDs   │  │  service JSON│         │
│  │              │  │              │         │
│  └──────────────┘  └──────────────┘         │
│                                              │
│  ──────────────────────                      │
│                       [Cancel] [Next →]      │
└──────────────────────────────────────────────┘
```

**Step 2 — Credentials:** Existing dropdown + "Add new" expandable form (drop .p8 / JSON, test, save).

**Step 3 — App Selection:** 
- iOS: discovered apps list (radio cards)
- Android: package name input + auto-validate regex

Submit → "Connecting..." → success toast + redirect.

## 6.7 App Detail Frame (Sekme Sistemi)

App detail layout — tüm sub-page'lerin shell'i:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Apps                                                                      │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  Aa  Cyber Clash                              [Pull from store]     │    │
│  │  iOS · com.gripati.cyberclash · v1.2.3        [Push to store ▾]     │    │
│  │  READY · 35 locales · 3 dirty                                       │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│  ──────────────────────────────────────────────                              │
│                                                                              │
│  ┌──────────┬───────────┬─────────────┬──────────┬──────────┬──────────┐    │
│  │ Overview │ Metadata  │ Screenshots │ Previews │  Builds  │ Submit / │    │
│  │          │     ⊙ 3   │  142 imgs   │  0 vids  │   v1.2.3 │ History  │    │
│  └──────────┴───────────┴─────────────┴──────────┴──────────┴──────────┘    │
│  ─── hairline ────────────────                                               │
│                                                                              │
│  (tab content)                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Tab strip:** her tab text + sub-meta (count, dot). Active tab: 2px signal underline + Fraunces. Inactive: Geist gray.

## 6.8 Metadata Tab — KAHRAMAN SAYFA

Bu sayfa kullanıcının **en sık** açtığı yer. Skill'in "unforgettable element" hedefini burada vurgularız.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Metadata                                          [↓ Import] [↑ Export]     │
│  35 locales · 3 dirty                              [↻ Pull] [→ Push ▾]       │
│  ──────────────────────────────────                                          │
│                                                                              │
│  ┌────────────────────────┬─────────────────────────────────────────────┐    │
│  │ LOCALES                │ en-US · English (United States)  PRIMARY   │    │
│  │ ───────                │ ──────────────────────────────────          │    │
│  │ [🔍 search]            │                                             │    │
│  │ [Dirty only ☐] [Empty only ☐]                                        │    │
│  │                        │ Name                       (30 char limit) │    │
│  │ Aa  en-US     30/30 ●  │ ┌──────────────────────────────────────────┐│    │
│  │ Aş  tr        28/30 ⊙  │ │ Word Stack Solitaire                     ││    │
│  │ あ  ja        24/30 ●  │ └──────────────────────────────────────────┘│    │
│  │ 한  ko        26/30 ●  │ ──── 20/30 ───────────                      │    │
│  │ Áa  es-ES     30/30 ●  │                                             │    │
│  │ Áa  es-MX      —/30 ○  │ Subtitle (iOS · 30 char)                    │    │
│  │ Çã  pt-BR      —/30 ○  │ ┌──────────────────────────────────────────┐│    │
│  │ أب  ar-SA     29/30 ●  │ │ Word Puzzle & Card Brain Game            ││    │
│  │ Яб  ru        30/30 ●  │ └──────────────────────────────────────────┘│    │
│  │ 字  zh-Hans   18/30 ●  │ ──── 28/30 ───────────                      │    │
│  │ ··· (26 more)          │                                             │    │
│  │ [+ Add locale]         │ Description                  (4000 char)    │    │
│  │                        │ ┌──────────────────────────────────────────┐│    │
│  └────────────────────────┘ │ WORD STACK SOLITAIRE                     ││    │
│                             │ Stack. Match. Solve. Welcome to Word     ││    │
│                             │ Stack Solitaire — where classic ...      ││    │
│                             │ ...                                      ││    │
│                             │                                          ││    │
│                             │ (scrollable, line numbers in margin)     ││    │
│                             │                                          ││    │
│                             └──────────────────────────────────────────┘│    │
│                             ──── 3842/4000 ───────────                  │    │
│                                                                         │    │
│                             Keywords (iOS · 100 char, comma-separated)  │    │
│                             ┌──────────────────────────────────────────┐│    │
│                             │ word,solitaire,puzzle,brain,card,daily,..││    │
│                             └──────────────────────────────────────────┘│    │
│                             ──── 98/100 ───────────                     │    │
│                                                                         │    │
│                             Promotional Text (iOS · 170 char)           │    │
│                             ┌──────────────────────────────────────────┐│    │
│                             │ The ultimate word-card hybrid! ...       ││    │
│                             └──────────────────────────────────────────┘│    │
│                             ──── 142/170 ───────────                    │    │
│                                                                         │    │
│                             What's New (4000 char)                      │    │
│                             ┌──────────────────────────────────────────┐│    │
│                             │ * Minor bug fixes and performance ...    ││    │
│                             └──────────────────────────────────────────┘│    │
│                             ──── 47/4000 ──                             │    │
│                                                                         │    │
│                             URLs                                        │    │
│                             Marketing  ┌────────────────────────────┐  │    │
│                                        │ https://emrepehlevan.com/  │  │    │
│                                        └────────────────────────────┘  │    │
│                             Support    ┌────────────────────────────┐  │    │
│                                        │ https://emrepehlevan.com/  │  │    │
│                                        └────────────────────────────┘  │    │
│                             Privacy    ┌────────────────────────────┐  │    │
│                                        │ https://emrepehlevan.com/  │  │    │
│                                        └────────────────────────────┘  │    │
│                                                                         │    │
│                             ── This locale ── [Discard] [Save locally]  │    │
│                                                                         │    │
│                             ⊙ Unsaved changes since last fetch          │    │
│                                                                         │    │
│  ─── divider ───                                                             │
│                                                                              │
│  Version Settings (iOS, language-independent)                                │
│  Version  [1.2.3      ]  Release [▾ Manual         ]  Copyright [© 2026...] │
│  Earliest release date  [—] (only for SCHEDULED)                             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Detaylar:**
- **Sol panel** locale rail (`LocaleChip` component); border-left 2px signal when selected; pulse animation on dirty
- **Sağ panel** form; her input altında `CharLimitBar`
- **Description textarea**: line numbers margin (mono xs gray); auto-expand height; tab-to-indent off
- **"PRIMARY" stamp** locale isminin yanında ink stamp (sadece primary locale'de)
- **URLs grouped** alt section, hairline border separated
- **"⊙ Unsaved changes"** indicator footer'da, dirty bit göstergesi

**Push button flow (KRİTİK UX):**
1. Click [→ Push to store ▾]
2. Dropdown: Push this locale / Push dirty (3) / Push everything (35) / **Preview changes…**
3. Preview Sheet açılır (DiffSheet, bkz. `12_DESIGN_SYSTEM.md` 12.7.8)
4. Word-level diff her field için
5. "Unsupported in Google Play" uyarı listesi
6. [Cancel] / [Confirm push]
7. Confirm → 202 jobId → toast "Pushing 3 locales…" → SSE progress in topbar Jobs badge
8. Success → toast + dirty state clear + confetti micro-burst on header

**Motion:**
- Locale chip select: signal underline slide-in (left → right) 240ms
- Char limit bar: smooth width + color transition 240ms
- Save locally: button checkmark morph (200ms)
- Push success: full screen subtle confetti (10 particles, 1s)

**Edge case'ler:**
- Description > limit: form field 2px danger border, save button disabled, message under bar
- Two simultaneous edits (V2 multi-user): lock indicator + "Sarah is editing tr now" overlay
- Network fail during save: optimistic kept + retry toast
- Locale exists in Apple but not Google: "Will skip on Android push" badge

**A11y:**
- Locale rail: arrow key nav (up/down), Enter select
- Textarea: Tab moves out (no indent capture)
- All form fields: label association, aria-describedby for char counter
- Live region for dirty state changes

## 6.9 Master JSON Import (Modal)

```
┌──────────────────────────────────────────────┐
│  Import master JSON                     [✕]  │
│  ───────────────────────────                 │
│                                              │
│  ┌────────────────────────────────────────┐ │
│  │                                        │ │
│  │  ↑ Drop JSON file or click to browse   │ │
│  │                                        │ │
│  │  Schema: 1.0 · UTF-8                   │ │
│  │  Max 5 MB · max 200 locales            │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  Selected: word_stack_master.json (152 KB)   │
│  ✓ Schema valid · 35 locales detected        │
│                                              │
│  ── Locale matching preview ──               │
│  ✓ Found:   en-US, tr, ja, ko, es-ES, ...   │
│  + Will add: pt-PT (new in Apple)            │
│  ⚠ Unsupported Google Play: fr-CH, de-AT     │
│  ⚠ Will truncate:                            │
│     • de · app_name: 38 → 30 chars           │
│     • th · keywords: 112 → 100 chars         │
│                                              │
│  Options                                     │
│  ☑ Auto-truncate to platform limits          │
│  ☐ Only new locales (skip existing)          │
│  ☐ Dry run (preview only, don't save)        │
│                                              │
│  ──────────────────────────                  │
│            [Cancel]  [Import 35 locales →]   │
└──────────────────────────────────────────────┘
```

Drop zone: drag-over signal-tint background pulse. Validation real-time.

## 6.10 Screenshots Tab

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Screenshots                                                                 │
│  Locale: [▾ en-US English]                                                   │
│                                                                              │
│  ┌──────────────────┬──────────────────┐         [+ Other device types ▾]   │
│  │ APP_IPHONE_65    │ APP_IPAD_PRO_3GEN│                                    │
│  │ 10 / 10 slots    │ 8 / 10 slots     │                                    │
│  │ ────             │                  │                                    │
│  └──────────────────┴──────────────────┘                                    │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ APP_IPHONE_65 · iPhone 6.5"                                          │    │
│  │ 1284×2778 · PNG/JPEG · max 8 MB                                      │    │
│  │ [↑ Upload] [📁 Import folder] [↻ Pull] [→ Push] [⎘ Apply to others]  │    │
│  │ ─── divider ───                                                      │    │
│  │                                                                      │    │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                                  │    │
│  │  │ 01 │ │ 02 │ │ 03 │ │ 04 │ │ 05 │                                  │    │
│  │  │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │                                  │    │
│  │  │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │                                  │    │
│  │  │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │                                  │    │
│  │  │ ●  │ │ ●  │ │ ●  │ │ ●  │ │ ●  │                                  │    │
│  │  └────┘ └────┘ └────┘ └────┘ └────┘                                  │    │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                                  │    │
│  │  │ 06 │ │ 07 │ │ 08 │ │ 09 │ │ 10 │                                  │    │
│  │  │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │                                  │    │
│  │  │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │                                  │    │
│  │  │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │ │ ▮▮ │                                  │    │
│  │  │ ●  │ │ ●  │ │ ●  │ │ ●  │ │ ●  │                                  │    │
│  │  └────┘ └────┘ └────┘ └────┘ └────┘                                  │    │
│  │                                                                      │    │
│  │  All 10 slots filled · COMPLETE ✓                                    │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ── Apply this set to other locales ──                                       │
│  Copy current screenshots to:                                                │
│  [+ tr] [+ ja] [+ ko] [+ es-ES] [+ select all 34 locales]                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Card detayları:**
- Ordinal number: `--type-mono-sm` üst-sol köşe
- State dot bottom-center: synced/syncing/error/processing
- Hover → scale 1.04 + signal halo
- Click → lightbox modal (büyük preview + meta + actions)
- Drag handle → reorder; drop zone outline glow

**"Apply to other locales" — Benzersiz Değer:**
Mevcut Unity'de yok. Web'de yeni: bir tıkla aynı screenshot set'i 34 locale'e kopyala (her locale için ayrı upload job spawn).

**Upload Modal:**

```
┌──────────────────────────────────────────────┐
│  Upload to APP_IPHONE_65 · en-US        [✕]  │
│  ───────────────────────────                 │
│                                              │
│  ┌────────────────────────────────────────┐ │
│  │                                        │ │
│  │  ↑ Drop files or click to browse       │ │
│  │                                        │ │
│  │  PNG/JPEG · max 8 MB · 1284×2778       │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  Selected (3 files):                         │
│  ✓ screenshot-1.png  1284×2778  2.1 MB       │
│  ✓ screenshot-2.png  1284×2778  1.9 MB       │
│  ⚠ screenshot-3.png  1080×1920  Invalid      │
│                                                                            │
│  Start at position: [▾ End (11)]             │
│                                              │
│         [Cancel]    [Upload 2 valid →]       │
└──────────────────────────────────────────────┘
```

## 6.11 Previews Tab (iOS)

Screenshots ile aynı pattern. Farklar:
- Card poster image + ▶ play overlay + duration badge
- Click → modal video player (HTML5 video, preview)
- Max 3 per locale
- previewType `IPHONE_65` (APP_ prefix yok); UI'da `[+ Other types ▾]` dropdown
- Upload spec: .mp4/.mov/.m4v, max 500 MB, server-side ffprobe validation

## 6.12 Android Images Tab

Sub-tabs per image type (icon, featureGraphic, tvBanner, promoGraphic, phoneScreenshots, sevenInch..., tenInch..., tv, wear). Each shows correct spec + grid.

## 6.13 Builds Tab (V1.5)

```
│ Builds                                            [+ Upload AAB/IPA]         │
│ ─────────────────                                                            │
│                                                                              │
│ ┌──────┬──────┬─────────────────┬─────────────────┬──────────────┐          │
│ │ Ver  │ Build│ Uploaded        │ State           │ Actions      │          │
│ ├──────┼──────┼─────────────────┼─────────────────┼──────────────┤          │
│ │ 1.2.3│  14  │ 2 days ago      │ ● VALID         │ [Submit] [⋮] │          │
│ │ 1.2.3│  13  │ 5 days ago      │ ● EXPORT_READY  │ [⋮]          │          │
│ │ 1.2.2│  12  │ 2 weeks ago     │ ● INVALID       │ [⋮]          │          │
│ └──────┴──────┴─────────────────┴─────────────────┴──────────────┘          │
│                                                                              │
│ ── Upload new build ──                                                       │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ ↑ Drop IPA/AAB file or click to browse                               │    │
│ │ Max 500 MB · timeout 30 min                                          │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│   Release notes: ┌────────────────────────────────────────────┐             │
│                  │                                              │             │
│                  └────────────────────────────────────────────┘             │
```

Upload progress: SSE-driven bar (MB / total + ETA + speed).

## 6.14 Submission Tab (V1.5)

```
│ Submit for Review                                                            │
│ ──────────────────                                                           │
│                                                                              │
│ Selected build: v1.2.3 (Build 14)        [Change build]                      │
│                                                                              │
│ ── Pre-flight checklist ──                                                   │
│ ✓ Build is valid                                                             │
│ ✓ All required metadata fields filled                                        │
│ ✓ APP_IPHONE_65 has 10/10 screenshots                                        │
│ ⚠ APP_IPAD_PRO_3GEN_129 has 8/10 screenshots (10 ideal)                      │
│ ✗ App Preview missing (recommended)                                          │
│                                                                              │
│ ── Submission details ──                                                     │
│ Release type: [▾ Manual release after approval]                              │
│ Notes for review (optional)                                                  │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ Test account credentials: test@example.com / password123             │    │
│ │ ...                                                                  │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│              [Cancel]              [→  Submit for review]                    │
```

Submit button click → confirmation modal with last-check ("This will submit to Apple — you cannot undo. Continue?") → API call → success state.

## 6.15 History Tab (app-scoped)

```
│ Activity                                                                     │
│ Filter: [▾ All actions] [▾ All users] [date range]                           │
│ ─────────────────                                                            │
│                                                                              │
│ Sun · May 17 · 14:23     You                metadata.push      SUCCESS       │
│   ▶ en-US: description (updated), keywords (updated)                         │
│   ▶ tr: description (updated), whatsNew (updated)                            │
│   ▶ ja: description (updated)                                                │
│                                                                              │
│ Sun · May 17 · 14:15     You                screenshot.upload  SUCCESS       │
│   • Locale en-US, Device APP_IPHONE_65, Ordinal 11                           │
│   • File: screenshot-11.png (2.3 MB)                                         │
│                                                                              │
│ Sat · May 16 · 09:01     System (Apple)     status.change      INFO          │
│   • PREP_FOR_SUBMISSION → READY_FOR_SALE                                     │
│                                                                              │
│ Fri · May 15 · 18:43     Sarah Müller       member.invite      SUCCESS       │
│   • Invited dev@example.com as EDITOR                                        │
```

Timeline view with collapsible details.

## 6.16 Credentials (`/t/[slug]/credentials`)

```
│ API Credentials                                  [+ Add credential]          │
│ ────────────────                                                             │
│                                                                              │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ ●  APPLE        Apple Prod                                  [⋮]      │    │
│ │     Issuer: 57246542-96fe-1a63-e053-0824d011072a                     │    │
│ │     Key ID: ABC***DEF4                                               │    │
│ │     Last test: ✓ Connected · 2 min ago                               │    │
│ │     Used by: 2 apps                                                  │    │
│ │     ──────                                                           │    │
│ │     [Test] [Rotate]                                                  │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ ●  GOOGLE       Google Play Main                            [⋮]      │    │
│ │     Client: gp-service@my-project.iam...                             │    │
│ │     Project: my-project-12345                                        │    │
│ │     Last test: ✓ Connected · 5 min ago                               │    │
│ │     Used by: 1 app                                                   │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
```

Add credential drawer (right Sheet): tip seçimi → form fields → file drop zones (.p8 / JSON) → test connection → save.

## 6.18 Jobs Panel (`/t/[slug]/jobs`)

```
│ Jobs                                                                         │
│ Filter: [Active (2)] [Completed (47)] [Failed (3)] [All]                     │
│ ─────────────────                                                            │
│                                                                              │
│ ── ACTIVE ──                                                                 │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ ⊙  metadata.push.bulk · Cyber Clash (iOS)                            │    │
│ │     Started 2 min ago by You                                         │    │
│ │     ▓▓▓▓▓▓▓░░░░░░░░░░ 12 of 35                                       │    │
│ │     Current: tr · "Created appStoreVersionLocalization"              │    │
│ │     ──────                                                           │    │
│ │     [Details] [Cancel]                                               │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ ⊙  screenshot.upload · Word Stack (iOS)                              │    │
│ │     ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░ 78% · 1.2 / 1.5 MB                              │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│ ── FAILED ──                                                                 │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ ✗  screenshot.upload · Word Stack (iOS)                              │    │
│ │     Failed 1 hour ago after 3 attempts                               │    │
│ │     Error: UPLOAD_FAILED — S3 PUT returned 403                       │    │
│ │     Locale: en-US, Device: APP_IPHONE_65                             │    │
│ │     [Details] [↻ Retry]                                              │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
```

Job detail modal: full timeline (log events, timestamp + level color), request/response (redacted), retry button, copy job ID.

## 6.19 Team / Members (`/t/[slug]/team`)

```
│ Team                                              [+ Invite member]          │
│ 4 members · 1 invitation pending                                             │
│ ─────────────────                                                            │
│                                                                              │
│ ── Active members ──                                                         │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ Aa  Emre Pehlevan                  emrepehlevan@example.com  OWNER   │    │
│ │     joined 3 months ago · last active 2 min ago                      │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ Aa  Sarah Müller                   sarah@example.com         EDITOR  │    │
│ │     joined 2 weeks ago · last active yesterday              [Change] │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│ ── Pending invitations ──                                                    │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │ ⊙  dev@example.com                  invited 2 days ago      EDITOR   │    │
│ │     expires in 5 days                                                │    │
│ │     [Resend invitation] [Revoke]                                     │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
```

Invite modal:
```
│ Invite to Gripati Studio                                                     │
│ ───────────────────────                                                      │
│ Email                                                                        │
│ ┌──────────────────────────────────────────┐                                │
│ │ colleague@example.com                    │                                │
│ └──────────────────────────────────────────┘                                │
│ Role                                                                         │
│ ○ ADMIN       Full access except billing                                     │
│ ○ MAINTAINER  Credentials, apps add/remove                                   │
│ ● EDITOR      Metadata edit + push (default)                                 │
│ ○ VIEWER      Read-only                                                      │
│                                                                              │
│ Personal note (optional)                                                     │
│ [textarea]                                                                   │
│                                                                              │
│         [Cancel]              [→ Send invitation]                            │
```

## 6.20 Settings → Billing (SaaS, V2)

```
│ Billing                                                                      │
│ ─────────────────                                                            │
│                                                                              │
│ ── Current plan ──                                                           │
│ ┌──────────────────────────────────────────────────────────────────────┐    │
│ │  PRO PLAN                                              [Change plan] │    │
│ │  $29 / month · billed monthly                                        │    │
│ │  Next invoice: $29.00 on Jun 17, 2026                                │    │
│ │  ──────                                                              │    │
│ │  Usage this period:                                                  │    │
│ │  Apps:        12 / 25                                                │    │
│ │  Members:      4 / 10                                                │    │
│ │  Pushes:     142 / 1000                                              │    │
│ └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│ ── Payment method ──                                                         │
│ Visa •••• 4242                                                               │
│ [Manage payment methods]                                                     │
│                                                                              │
│ ── Invoices ──                                                               │
│ May 17 2026  $29.00  Pro plan · monthly  [Download PDF]                      │
│ Apr 17 2026  $29.00  Pro plan · monthly  [Download PDF]                      │
│                                                                              │
│ ── Danger zone ──                                                            │
│ [Cancel subscription]                                                        │
```

Manage button → Stripe Customer Portal (external).

## 6.21 Settings → Tenant Danger Zone

```
│ Danger zone                                                                  │
│ ──────────                                                                   │
│                                                                              │
│ ── Change workspace slug ──                                                  │
│ Current: gripati                                                             │
│ Changing this breaks all bookmarked URLs.                                    │
│ [Change slug]                                                                │
│                                                                              │
│ ── Transfer ownership ──                                                     │
│ Transfer this workspace to another member.                                   │
│ [Transfer to...]                                                             │
│                                                                              │
│ ── Delete workspace ──                                                       │
│ This will:                                                                   │
│ • Delete all apps, metadata, screenshots                                     │
│ • Delete all credentials (secrets purged immediately)                        │
│ • Remove all members                                                         │
│ • Cancel subscription (if SaaS)                                              │
│ • 30-day grace period before hard delete                                     │
│                                                                              │
│ Type "delete gripati" to confirm:                                            │
│ [____________________________]                                               │
│ [Delete workspace]                                                           │
```

Tüm "Danger" işlemler: type-to-confirm + secondary confirmation modal + irreversible warning.

## 6.22 Onboarding Flow (SaaS V2 — Yeni Signup Sonrası)

5 adımlı walkthrough overlay (Cmd+/ ile skip OK):

```
Step 1: Welcome · 30 saniyelik tour
Step 2: Choose your platform (iOS / Android / Both)
Step 3: Add your first credential (Apple .p8 ya da Google JSON drop)
Step 4: Connect your first app (Discover Apple veya package name)
Step 5: First push success → confetti + redirect dashboard
```

Her step'te progress bar + "Skip for now" + back/next.

## 6.23 Cross-Cutting UI Patterns

### 6.23.1 Toast System

- Position top-right
- 4 variants: success / warning / danger / info (signal-toned left border)
- Duration: 5s default; actionable toasts persistent
- Stack: max 3, oldest fade-out

### 6.23.2 Keyboard Shortcuts

```
Cmd+K       Command palette (universal)
Cmd+P       Push current locale
Cmd+S       Save locally
Cmd+/       Help overlay
Cmd+B       Toggle sidebar
Cmd+Shift+L Switch theme
Cmd+1..9    Switch tenant (first 9)
g a         Go to apps
g d         Go to dashboard
g s         Go to settings
g t         Go to team
?           Show all shortcuts
Esc         Close modal/sheet/palette
```

### 6.23.3 Command Palette (Cmd+K)

```
┌──────────────────────────────────────────────┐
│ 🔍 Search…                                   │
│ ─────────────────                            │
│ TENANTS                                      │
│   Aa  Gripati Studio (current)               │
│   Aa  Acme Mobile                            │
│   Aa  Freelance Clients                      │
│                                              │
│ APPS                                         │
│   ●  Cyber Clash (iOS)                       │
│   ●  Cyber Clash (Android)                   │
│                                              │
│ ACTIONS                                      │
│   ↑  Push all dirty metadata                 │
│   ↓  Import master JSON                      │
│   +  Add new app                             │
│                                              │
│ NAVIGATION                                   │
│   📊 Go to dashboard         ⌘1              │
│   📦 Go to apps              ⌘2              │
│   🔐 Go to credentials       ⌘3              │
│                                              │
│ ─────────────────                            │
│ ↑↓ navigate · ↵ select · esc close           │
└──────────────────────────────────────────────┘
```

cmdk library. Tenant switch + app open + quick action + nav.

### 6.23.4 Theme Switcher

Topbar `[Theme]` icon → dropdown: Light / Dark / System. Switch transition: full-screen radial reveal from button position (600ms).

### 6.23.5 Real-Time Multi-User Indicators (V2)

Aynı metadata locale'i 2 user düzenlerse:
- "Sarah is editing this now" overlay banner
- Editing avatar follows cursor (presence indicator)
- Conflict detection: optimistic save fails → 409 → merge UI

### 6.23.6 Error Boundary

Per-route `error.tsx`:

```
│  ⚠                                                                           │
│                                                                              │
│  Something went sideways                                                     │
│                                                                              │
│  We couldn't load this page.                                                 │
│  Try refreshing, or check the activity log for details.                      │
│                                                                              │
│  [Try again]  [View logs]  [Report this issue]                               │
│                                                                              │
│  Error ID: req-7d2f-1a8c-9b4e                                                │
│  ───────                                                                     │
```

Editorial empty-state energy — şikayet etmez, çözüm sunar.

### 6.23.7 Loading States

3 stratejisi:
- **Skeleton** for lists/tables (>300ms expected)
- **Spinner inline** in buttons (`isPending`)
- **Page-level loader** for route transitions: top progress bar (NProgress-like, 2px signal)

### 6.23.8 Empty States

Her ana route'un kendi empty state'i:
- Dashboard (no apps): "Edition Zero" hero
- Apps (no apps): "Connect first app" with sample images
- Credentials (none): "Apple, Google, ?" 3 card layout
- Audit (no events): "History is empty — your activity will appear here"

Tek bir formül değil — her sayfada **kendi karakterine uygun** boş hali.

## 6.24 Responsive

| Width | Mode |
|-------|------|
| < 768 | "Open on desktop" sayfası — link to email reminder |
| 768-1024 | Read-only mode (V2, mobile users monitor jobs etc.) |
| 1024-1280 | Sidebar collapses to icon-only (40px); content fluid |
| 1280-1600 | Full layout |
| 1600+ | Content max-w 1440 centered; left margin grows |

V1: Desktop-only zorunlu. V2: Mobile read-only + push-from-mobile (panic button "deploy hotfix").

## 6.25 RTL Support

Arabic, Hebrew, Persian, Urdu locales için:

```css
[dir="rtl"] {
  /* Layout mirrors */
}

[lang="ar"], [lang="he"], [lang="fa"], [lang="ur"] {
  direction: rtl;
}
```

- Sidebar sağa kayar
- Text alignment right
- Locale chips düzgün hizalanır
- Icons mirror edilir (chevron-right → chevron-left programmatically)
- App data RTL preservation (description Arapça yazıldığında textarea direction auto)

UI dili (Türkçe/English) ayrı; sadece içerik locale'i RTL'i etkiler.

## 6.26 A11y Final Checklist

- [ ] WCAG 2.1 AA kontrast (axe-core CI'da)
- [ ] All interactive: aria-label + visible focus ring
- [ ] Keyboard nav: full coverage (Tab/Shift+Tab/Enter/Esc/Arrow)
- [ ] Screen reader test: NVDA + VoiceOver MVP öncesi
- [ ] `prefers-reduced-motion`: animasyonları 0.01ms'e indir
- [ ] `prefers-color-scheme`: system default initial theme
- [ ] Focus trap: modal/sheet/palette
- [ ] Skip-to-content link
- [ ] Form errors: aria-invalid + aria-describedby
- [ ] Live regions: progress, toasts, status changes
- [ ] Color-not-alone: state dot + text label hep birlikte
- [ ] Touch targets: min 44×44px (mobile readiness)

## 6.27 Sayfa Component Haritası (Geliştirici Referansı)

```
apps/web/src/app/
├── (auth)/
│   ├── login/page.tsx                  → LoginPage
│   ├── signup/page.tsx                 → SignupPage (SaaS)
│   └── accept-invite/[token]/page.tsx  → AcceptInvitePage
├── (dashboard)/t/[tenantSlug]/
│   ├── layout.tsx                      → TenantShell (sidebar+topbar+tenant-context)
│   ├── dashboard/page.tsx              → DashboardPage
│   ├── apps/
│   │   ├── page.tsx                    → AppsListPage
│   │   └── [appId]/
│   │       ├── layout.tsx              → AppShell (sub-tabs)
│   │       ├── overview/page.tsx       → OverviewPage
│   │       ├── metadata/page.tsx       → MetadataPage ← KAHRAMAN
│   │       ├── screenshots/page.tsx    → ScreenshotsPage
│   │       ├── previews/page.tsx       → PreviewsPage
│   │       ├── builds/page.tsx         → BuildsPage
│   │       ├── submission/page.tsx     → SubmissionPage
│   │       └── history/page.tsx        → HistoryPage
│   ├── credentials/page.tsx
│   ├── audit/page.tsx
│   ├── jobs/page.tsx
│   ├── team/page.tsx
│   └── settings/
│       ├── profile/page.tsx
│       ├── tenant/page.tsx
│       ├── preferences/page.tsx
│       ├── billing/page.tsx            (SaaS)
│       ├── api-tokens/page.tsx         (V2)
│       └── danger/page.tsx
└── (admin)/admin/...                   (PlatformAdmin, SaaS)

apps/web/src/components/
├── shell/
│   ├── TenantShell.tsx
│   ├── Sidebar.tsx
│   ├── Topbar.tsx
│   ├── TenantSwitcher.tsx
│   ├── JobsBadge.tsx
│   ├── CommandPalette.tsx
│   └── ThemeSwitcher.tsx
├── metadata/
│   ├── LocaleRail.tsx
│   ├── LocaleChip.tsx
│   ├── MetadataEditor.tsx
│   ├── CharLimitBar.tsx
│   ├── VersionSettingsForm.tsx
│   ├── ImportMasterJsonModal.tsx
│   ├── PushButton.tsx
│   └── DiffSheet.tsx                   ← differentiation
├── screenshots/
│   ├── DeviceTypeTabs.tsx
│   ├── ScreenshotGrid.tsx              (dnd-kit)
│   ├── ScreenshotCard.tsx
│   ├── UploadModal.tsx
│   ├── BulkApplyDialog.tsx
│   └── Lightbox.tsx
├── jobs/
│   ├── JobProgressCard.tsx
│   ├── JobLogTimeline.tsx
│   └── JobDetailModal.tsx
├── credentials/
│   ├── CredentialCard.tsx
│   ├── AddCredentialSheet.tsx
│   └── TestConnectionButton.tsx
├── app/
│   ├── AppCard.tsx
│   ├── ConnectAppWizard.tsx
│   └── AppHeader.tsx
├── team/
│   ├── MemberRow.tsx
│   └── InviteModal.tsx
└── feedback/
    ├── Toaster.tsx                     (Sonner config)
    ├── StateDot.tsx
    ├── Stamp.tsx                       (editorial label)
    └── EmptyState.tsx
```

## 6.28 Sayfa Açılış Performans Hedefi

| Sayfa | TTI hedef | LCP hedef | Notlar |
|-------|-----------|-----------|--------|
| Login | < 1.2s | < 1.0s | Critical CSS inline; no fetch |
| Dashboard | < 1.8s | < 1.5s | Stats SSR (RSC); jobs hydrated |
| Apps list | < 1.5s | < 1.2s | Server fetch + edge cache 30s |
| Metadata | < 2.5s | < 2.0s | 35 locale lazy load; only selected hidrate |
| Screenshots | < 2.0s | < 1.8s | Thumbnail lazy + blur placeholder |
| Jobs | < 1.5s | — | SSE post-load |

Tüm sayfalar `<head>` içinde preload critical fonts + signal accent color CSS var.
