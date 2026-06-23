# 12 — Design System

`anthropics/skills/frontend-design` skill metodolojisinin V1 baseline'ı. Bu doküman **tek doğruluk kaynağı** — tasarım kararları, design token'lar, component anatomy, motion specs ve "yapma" listesi.

## 12.0 Design Thinking (frontend-design Phase 1)

Skill, koda başlamadan **önce** dört soru zorunlu kılar. Cevaplarımız:

### Purpose
> Kim kullanır, hangi problemi çözer?

**Kullanıcı persona:** Indie geliştirici → küçük studio CTO. Aynı anda 5-15 uygulama yöneten kişi. Apple/Google Console'da gezinmekten yorulmuş; çok-dilli metadata, screenshot batch upload, dirty tracking gibi karmaşık iş akışlarında **odak** ister. Dashboard her gün açılıyor — uzun süreli aşinalık şart.

**Çözülen problem:** App Store Connect + Google Play Console'un parçalanmış UX'ini birleştirmek + Unity'den çıkarıp browser'a almak + multi-tenant SaaS-ready hale getirmek.

### Tone
> Hangi estetik kasıt?

Bold karar: **"Editorial-Technical Hybrid"**

İki dünyanın kavşağı:
- **Editorial**: gazete/dergi sayfalarının zarafeti — distinctive serif display font, generous negative space, asymmetric Swiss grid, paper-like warm background, ink-black text, hairline dividers
- **Technical**: developer dashboard yoğunluğu — tabular numbers, mono badge'ler, dense data tables, command palette (Cmd+K), keyboard shortcuts, monospaced IDs

İki dünya kırılırsa **monotonik** olur. Birleşimi distinct. Reference points: *The Browser Company Arc settings*, *Linear's command bar*, *Stripe's dashboard density*, *Are.na's editorial restraint*. Hiçbirinin kopyası değil — bu hibrit.

### Constraints
- WCAG 2.1 AA accessibility (kontrast 4.5:1, keyboard nav, screen reader)
- 1024px+ desktop hedef; tablet read-only V2
- Light + Dark theme zorunlu; system default
- Performance: FCP < 1.5s 3G fast, TTI < 3s
- 35+ locale display (Türkçe, Arapça RTL, Japonca, Çince) → typography Unicode coverage
- 4 plan tier (Free/Pro/Team/Enterprise) → conditional UI elements

### Differentiation
> Tek hatırlanacak şey ne?

**"İlk push butonuna tıkladığında, kullanıcının ekranı önce bir Diff Sheet ile karşılaşır."**

App Store Connect'te "Save" butonuna basarsın → bir şey değişmiş midir, neyi değiştirdin, daha sonra bilemezsin. Bizim **diff-first push** UX'i bunu yıkar:
- Push'tan önce hangi alanlarda hangi değişiklikler olduğu word-level diff ile
- Apple/Google'a hangi formatta (locale conversion, character truncate) gideceği önizleme
- Onaylanmadan **hiçbir şey** kaydedilmez

Bu, "control + transparency" hissi verir. **Tek hatırlanan**: "Hiç push'ta sürpriz yok."

İkinci hatırlanacak detay: **Locale chip'leri = tipografik karakter**. Locale `tr-TR` chip'i, **Fraunces** display'de küçük "Aa" ile birlikte — kendi karakter setini gösterir. Türkçe locale chip'inde "Aşk" yazısı, Japonca'da "あ", Arapça'da "أ" (RTL). Estetik bir detay ama **functional**: kullanıcı locale seçerken visual cue alır.

---

## 12.1 Aesthetic Direction Commitment

### Reddedilen yönler
| ❌ Yön | Niye reddedildi |
|--------|-----------------|
| "Modern AI dashboard" (mor gradient, glassmorphism) | Skill'in açıkça yasakladığı pattern |
| Material Design 3 | Generic; Google ekosistemine kilitler |
| Fluent UI | Microsoft kokar; karakter dışı |
| Tailwind Catalyst default | Çok yaygın; her SaaS aynı görünüyor |
| Linear-tarzı tek aksanlı koyu UI | Çok rahat ama "Editorial" tarafımız eksilirdi |
| Bento-Grid maximalism | Yoğun ama dashboard'da gözü yorar |
| Brutalist (Vercel-tarzı tüm-büyük-harf, sarı/siyah) | Çok agresif; günlük 8 saat kullanılmaz |
| Skeuomorphic | Anachronistik; 2026'da yer yok |

### Commit ettiğimiz yön

**"Editorial-Technical Hybrid"** üç pilon üzerine kurulur:

1. **Paper-like surface** — koyu tonlu zemin değil; warm off-white (light) veya warm graphite (dark)
2. **Ink hierarchy** — siyah-yakını metin + thin ink-line geometric dividers (0.5px @ 1x DPI)
3. **Signal accent** — tek dramatik kırmızı-turuncu, sadece kritik action'larda (Push, Submit, Delete confirm); ortalama bir sayfada **maksimum 3-4 noktada** görünür

---

## 12.2 Color System

### 12.2.1 Light Theme (Primary)

```css
:root[data-theme="light"] {
  /* Surfaces — paper warmth */
  --surface-paper:        #FAF8F2;   /* arka plan (sayfa) */
  --surface-elevated:     #FFFFFF;   /* kartlar, modals */
  --surface-sunken:       #F2EFE8;   /* nested cards, code blocks */
  --surface-tinted:       #F6F3EB;   /* hover background */

  /* Ink — text & strokes */
  --ink-primary:          #0E0E0C;   /* başlıklar, body */
  --ink-secondary:        #4A4842;   /* meta, captions */
  --ink-tertiary:         #847F75;   /* placeholder, disabled */
  --ink-quaternary:       #C9C3B5;   /* iconlar inactive */

  /* Strokes — hairlines */
  --stroke-soft:          rgba(14, 14, 12, 0.06);   /* hover divider */
  --stroke-default:       rgba(14, 14, 12, 0.10);   /* card borders */
  --stroke-strong:        rgba(14, 14, 12, 0.22);   /* focus ring */
  --stroke-emphasis:      rgba(14, 14, 12, 0.55);   /* selected state */

  /* Signal — single dramatic accent */
  --signal:               #E84B1E;   /* primary action */
  --signal-hover:         #C73E18;
  --signal-pressed:       #A93315;
  --signal-tint:          #FBE2D9;   /* accent badge bg */
  --signal-on:            #FFFFFF;   /* text on signal */

  /* Semantic — minimal palette, no rainbow */
  --status-success:       #2D6A4F;   /* deep forest green */
  --status-success-tint:  #D8E8DD;
  --status-warning:       #B85C00;   /* burnt amber */
  --status-warning-tint:  #F5E1C8;
  --status-danger:        #9B2226;   /* deep oxblood */
  --status-danger-tint:   #EBD3D4;
  --status-info:          #1B4965;   /* deep slate blue */
  --status-info-tint:     #D5E0EB;

  /* Platform accents — only in badges/chips, never primary action */
  --platform-apple:       #1D1D1F;   /* graphite */
  --platform-google:      #34A853;   /* material green */

  /* State indicators */
  --state-dirty:          #B85C00;   /* unpushed local edit */
  --state-syncing:        #1B4965;   /* in progress */
  --state-synced:         #2D6A4F;   /* live on store */
  --state-error:          #9B2226;
}
```

### 12.2.2 Dark Theme

Dark != "ink inverted on black". Karakteri korumak için **warm graphite** zemin.

```css
:root[data-theme="dark"] {
  --surface-paper:        #161614;   /* warm graphite, not pure black */
  --surface-elevated:     #1F1F1C;
  --surface-sunken:       #100F0E;
  --surface-tinted:       #252522;

  --ink-primary:          #F0EDE3;   /* parchment */
  --ink-secondary:        #B5B0A2;
  --ink-tertiary:         #7A7569;
  --ink-quaternary:       #4A4842;

  --stroke-soft:          rgba(240, 237, 227, 0.06);
  --stroke-default:       rgba(240, 237, 227, 0.10);
  --stroke-strong:        rgba(240, 237, 227, 0.28);
  --stroke-emphasis:      rgba(240, 237, 227, 0.65);

  --signal:               #FF6B41;   /* dark mode'da biraz daha parlak */
  --signal-hover:         #FF8460;
  --signal-pressed:       #E84B1E;
  --signal-tint:          rgba(255, 107, 65, 0.14);
  --signal-on:            #100F0E;

  --status-success:       #6EBE8F;
  --status-success-tint:  rgba(110, 190, 143, 0.14);
  --status-warning:       #E8A85F;
  --status-warning-tint:  rgba(232, 168, 95, 0.14);
  --status-danger:        #E26D72;
  --status-danger-tint:   rgba(226, 109, 114, 0.14);
  --status-info:          #6F9CC4;
  --status-info-tint:     rgba(111, 156, 196, 0.14);

  --platform-apple:       #F0EDE3;
  --platform-google:      #4DBE6A;

  --state-dirty:          #E8A85F;
  --state-syncing:        #6F9CC4;
  --state-synced:         #6EBE8F;
  --state-error:          #E26D72;
}
```

### 12.2.3 Color Usage Rules (kritik)

- **Dominant**: `--surface-paper` (sayfa %70+ kapsar)
- **Sharp accent**: `--signal` (sayfa %3'ten az kapsar — sadece tek-iki primary action)
- **Status colors**: badge'ler ve mikro-indikatörler (sayfa %5'i)
- **Asla** birden fazla bright accent yan yana (mor + cyan + pembe = generic AI)
- **Asla** gradient background (`linear-gradient(135deg, #6366F1, #EC4899)` = banned)
- **Asla** glassmorphism (backdrop-filter: blur — banned)

---

## 12.3 Typography System

### 12.3.1 Font Stack

```css
:root {
  /* Display — distinctive serif, optical sizing */
  --font-display: "Fraunces", "Charter", "Iowan Old Style", Cambria, "Hoefler Text", serif;

  /* Body — geometric grotesk */
  --font-body: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

  /* Mono — technical IDs, JSON, code */
  --font-mono: "IBM Plex Mono", "Geist Mono", "JetBrains Mono", "Fira Code", Consolas, monospace;
}
```

**Niye Fraunces?**
- Google Fonts'tan ücretsiz, geniş Unicode coverage (Türkçe, Arapça, CJK)
- **Variable axes**: opsz (9-144), wght (100-900), SOFT (0-100), WONK (0-1)
- Optical sizing — büyük başlıklarda zarif, küçük chip'lerde okunabilir
- "Distinctive yet readable" — magazine cover hissi ama editorial body'ye uygun
- Skill yasaklamadığı, henüz "overused" olmayan bir karakterli yüz

**Niye Geist?**
- Vercel tarafından açık-kaynak (OFL), benzersiz "geometric grotesk"
- Tabular numbers default açık (data table'lar için kritik)
- Türkçe + Arapça destek
- Skill'in yasakladığı Inter/Roboto/Arial DEĞİL

**Niye IBM Plex Mono?**
- Apache 2.0, geniş Unicode
- "Technical" karakter — IBM kurumsal hissi developer trust verir
- 7 weight, italic destek

### 12.3.2 Type Scale

```css
:root {
  /* Fluid scale (clamp ile responsive) */
  --type-overline:     400  10px / 1.4 var(--font-body);     letter-spacing: 0.08em; text-transform: uppercase;
  --type-caption:      400  12px / 1.45 var(--font-body);
  --type-body-sm:      400  13px / 1.55 var(--font-body);
  --type-body:         400  14px / 1.55 var(--font-body);    /* default */
  --type-body-lg:      400  16px / 1.6 var(--font-body);
  --type-label:        500  13px / 1.4 var(--font-body);     letter-spacing: -0.01em;

  /* Display — Fraunces, optical sized */
  --type-heading-sm:   500  18px / 1.3 var(--font-display);  font-variation-settings: "opsz" 18, "wght" 500, "SOFT" 0;
  --type-heading:      500  22px / 1.25 var(--font-display); font-variation-settings: "opsz" 22, "wght" 500;
  --type-heading-lg:   500  28px / 1.2 var(--font-display);  font-variation-settings: "opsz" 28, "wght" 500;
  --type-title:        450  36px / 1.1 var(--font-display);  font-variation-settings: "opsz" 36, "wght" 450, "SOFT" 30;
  --type-display:      400 clamp(56px, 8vw, 84px) / 0.95 var(--font-display); font-variation-settings: "opsz" 144, "wght" 400, "SOFT" 50;

  /* Mono — IBM Plex */
  --type-mono-xs:      400  11px / 1.4 var(--font-mono);     letter-spacing: 0.02em;
  --type-mono-sm:      400  12px / 1.5 var(--font-mono);
  --type-mono:         400  13px / 1.55 var(--font-mono);

  /* Numbers — tabular for data */
  --type-tabular:      450  14px / 1.4 var(--font-body);     font-variant-numeric: tabular-nums slashed-zero;
}
```

### 12.3.3 Typography Pairing Rules

| Use case | Font | Style |
|---------|------|-------|
| Page title (h1) | Display Fraunces | `--type-title`, SOFT 30, slightly tracked |
| Section header (h2) | Display Fraunces | `--type-heading-lg`, normal SOFT |
| Card title (h3) | Display Fraunces | `--type-heading-sm` |
| Body paragraph | Body Geist | `--type-body` |
| Form label | Body Geist | `--type-label`, 500 weight |
| Button | Body Geist | `--type-label`, slight letter-spacing |
| Locale chip text ("tr-TR") | Mono | `--type-mono-sm` |
| Locale chip CHARACTER sample ("Aşk", "أ") | Display Fraunces | inline style 18px |
| Data table cell number | Mono tabular | `--type-tabular` (data alignment) |
| Bundle ID, app ID | Mono | `--type-mono` |
| Timestamps | Mono tabular | `--type-mono-sm`, tabular nums |
| Hero (Empty state title) | Display Fraunces | `--type-display`, italic varyantı |
| Caption / meta | Body Geist | `--type-caption`, `--ink-secondary` |
| Overline (section dividers) | Body Geist uppercase | `--type-overline`, `--ink-tertiary` |

### 12.3.4 Multi-Language Considerations

```css
/* Locale-aware fallbacks */
[lang="ar"] {
  --font-display: "Reem Kufi Fun", "Noto Sans Arabic", var(--font-display);
  --font-body: "IBM Plex Sans Arabic", "Noto Sans Arabic", var(--font-body);
  direction: rtl;
}
[lang="ja"], [lang="ko"], [lang="zh-Hans"], [lang="zh-Hant"] {
  --font-display: "Noto Serif JP", var(--font-display);
  --font-body: "Noto Sans JP", var(--font-body);
}
[lang="hi"], [lang="bn"], [lang="ta"], [lang="te"] {
  --font-display: "Noto Sans Devanagari", var(--font-display);
}
```

### 12.3.5 Locale Character Showcase (Differentiation Detail)

Locale chip component'inin içeriği:
```
┌─────────────────────────┐
│  Aa   tr-TR     30/30   │   ← "Aa" = Türkçe sample, Display font 16px
└─────────────────────────┘
┌─────────────────────────┐
│  あ   ja        24/30   │   ← Japonca sample
└─────────────────────────┘
┌─────────────────────────┐
│  أ    ar-SA     29/30   │   ← Arapça sample (RTL)
└─────────────────────────┘
```

Function:
```ts
const LOCALE_SAMPLE: Record<string, string> = {
  "en": "Aa",   "tr": "Aş",  "es": "Áa", "fr": "Àe",  "de": "Äo",  "it": "Èa",  "pt": "Çã",
  "ru": "Яб",   "ja": "あ",  "ko": "한",  "zh-Hans": "字", "zh-Hant": "繁",
  "ar": "أب",   "he": "אב",  "hi": "अब", "bn": "অব",  "th": "กข",  "vi": "Ăà",
  "id": "Aa",   "ms": "Aa",  "tl": "Aa", "sw": "Aa",
};
function localeSample(locale: string): string {
  return LOCALE_SAMPLE[locale] || LOCALE_SAMPLE[locale.split("-")[0]] || "Aa";
}
```

---

## 12.4 Spacing & Layout

### 12.4.1 Spacing Scale

Tailwind defaults değil; **özel 5-step + golden-ratio fluid** scale:

```css
:root {
  --space-1: 4px;     /* hairline */
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;    /* default */
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
  --space-20: 80px;
  --space-24: 96px;
  --space-32: 128px;
  --space-40: 160px;
  --space-section: clamp(48px, 8vh, 96px);   /* section gap */
}
```

### 12.4.2 Radius

Minimal radius — editorial feel:

```css
:root {
  --radius-none: 0;
  --radius-xs: 2px;     /* badge, input */
  --radius-sm: 4px;     /* button */
  --radius: 6px;        /* card */
  --radius-lg: 10px;    /* modal, sheet */
  --radius-xl: 16px;    /* hero card */
  --radius-full: 9999px;
}
```

**Default:** En karakter veren karar **`--radius-xs`** (2px) inputs ve badges için. Yumuşacık 8-12px radius "SaaS clone" hissi verir.

### 12.4.3 Shadow & Elevation

**Soft, paper-on-paper** shadows:

```css
:root {
  --shadow-hairline: 0 0 0 0.5px var(--stroke-default);   /* ana kart border */
  --shadow-soft: 0 1px 0 var(--stroke-soft), 0 0 0 0.5px var(--stroke-default);
  --shadow-elevated: 0 1px 2px rgba(14, 14, 12, 0.04), 0 4px 12px rgba(14, 14, 12, 0.06), 0 0 0 0.5px var(--stroke-default);
  --shadow-popover: 0 8px 32px rgba(14, 14, 12, 0.12), 0 0 0 0.5px var(--stroke-default);
  --shadow-modal: 0 16px 48px rgba(14, 14, 12, 0.18);

  /* Inset for sunken */
  --shadow-inset: inset 0 0 0 0.5px var(--stroke-default);
}
```

**Hairline strokes** karakter veren detay — `0.5px` çizgi (1x DPI'da hairline, 2x'te 1px).

### 12.4.4 Grid System

**12 column Swiss grid + max-width 1440px**:

```css
.layout-frame {
  display: grid;
  grid-template-columns: 240px 1fr;  /* sidebar | content */
  min-height: 100vh;
}

.content-area {
  max-width: 1440px;
  padding-inline: var(--space-8) var(--space-12);
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--space-6);
}

/* Editorial asymmetry — 7+5, 8+4, 5+4+3 patterns */
.col-major { grid-column: span 7; }
.col-minor { grid-column: span 5; }
```

### 12.4.5 Density Levels

3 mod (Settings'ten seçilebilir):

| Mod | Line-height | Padding | Use case |
|-----|-------------|---------|----------|
| **Comfortable** | 1.6 | 16px | Default — günlük kullanım |
| **Compact** | 1.4 | 10px | Power user (Cmd+Shift+D toggle) |
| **Spacious** | 1.8 | 24px | Accessibility / large displays |

---

## 12.5 Motion System

### 12.5.1 Tempo

frontend-design skill'in altını çizdiği: **"one well-orchestrated page-load with staggered reveals creates more delight than scattered micro-interactions."**

```css
:root {
  /* Duration tokens */
  --motion-instant: 80ms;
  --motion-fast: 160ms;
  --motion-base: 240ms;
  --motion-slow: 380ms;
  --motion-deliberate: 600ms;
  --motion-grand: 900ms;        /* page-load orchestration */

  /* Easing — custom curves, NOT Material defaults */
  --ease-out-elegant: cubic-bezier(0.16, 1, 0.3, 1);     /* spring-like deceleration */
  --ease-out-quick: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-in-out-editorial: cubic-bezier(0.65, 0, 0.35, 1);
  --ease-anticipate: cubic-bezier(0.68, -0.4, 0.265, 1.55);  /* slight overshoot */
}

@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### 12.5.2 Page-Load Orchestration

Her sayfa açılışında **kademeli reveal**:

```css
@keyframes editorial-reveal {
  from {
    opacity: 0;
    transform: translateY(8px);
    filter: blur(2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
    filter: blur(0);
  }
}

.page-loaded > * {
  animation: editorial-reveal var(--motion-slow) var(--ease-out-elegant) both;
}

.page-loaded > *:nth-child(1) { animation-delay: 0ms; }
.page-loaded > *:nth-child(2) { animation-delay: 60ms; }
.page-loaded > *:nth-child(3) { animation-delay: 120ms; }
.page-loaded > *:nth-child(4) { animation-delay: 180ms; }
.page-loaded > *:nth-child(5) { animation-delay: 240ms; }
.page-loaded > *:nth-child(n+6) { animation-delay: 300ms; }
```

Bu, sayfa açılışında **bir gazetenin sayfalarının sırayla açıldığı hissini** verir.

### 12.5.3 Framer Motion Patterns (React)

```tsx
// Card hover — subtle lift
<motion.div
  whileHover={{ y: -2, transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}}
  className="card"
>

// List item enter (mount) — staggered children
<motion.ul
  initial="hidden"
  animate="visible"
  variants={{
    visible: { transition: { staggerChildren: 0.04 }},
  }}
>
  {items.map((item) => (
    <motion.li
      key={item.id}
      variants={{
        hidden: { opacity: 0, y: 8, filter: "blur(2px)" },
        visible: { opacity: 1, y: 0, filter: "blur(0)" },
      }}
      transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
    >
      <ListItem {...item} />
    </motion.li>
  ))}
</motion.ul>

// Modal — anticipate + scale
<motion.div
  initial={{ opacity: 0, scale: 0.98, y: 4 }}
  animate={{ opacity: 1, scale: 1, y: 0 }}
  exit={{ opacity: 0, scale: 0.98 }}
  transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
>

// Push button — micro pulse on success
<motion.button
  animate={pushSuccess ? { scale: [1, 1.06, 1] } : { scale: 1 }}
  transition={{ duration: 0.5, times: [0, 0.4, 1], ease: "easeOut" }}
>
```

### 12.5.4 Micro-Interactions Catalog

| Element | Trigger | Animation | Duration |
|---------|---------|-----------|----------|
| Button hover | mouseenter | `y: -1px`, signal-hover bg | 160ms |
| Button press | mousedown | `scale: 0.97` | 80ms |
| Input focus | focus | hairline → 1.5px signal ring, slight scale | 160ms |
| Card hover | mouseenter | `y: -2px`, shadow elevated | 160ms |
| Locale chip select | click | accent bg slide-in (left → right) | 240ms |
| Char limit cross | input | bar color fade (gray → amber → danger) | 240ms |
| Push success | request complete | confetti emit + button scale pulse | 500ms |
| Screenshot drag | dragstart | scale 1.04, shadow elevated, rotate 1° | 160ms |
| Screenshot drop | dragend | snap-back spring | 380ms |
| Job progress | SSE event | width transition smooth | 240ms |
| Toast enter | mount | slide-down + fade | 240ms |
| Modal enter | mount | scale 0.98 → 1 + fade | 240ms |
| Tab switch | click | underline slide (`x` translate) | 240ms |
| Theme toggle | click | full-screen radial reveal | 600ms |
| Empty state | first render | letter-by-letter typewriter (display font) | 900ms |

### 12.5.5 Scroll-Triggered Reveals (Marketing pages V2)

```tsx
import { motion, useScroll, useTransform } from "framer-motion";

function HeroSection() {
  const { scrollY } = useScroll();
  const parallaxY = useTransform(scrollY, [0, 500], [0, -120]);
  const opacityIn = useTransform(scrollY, [0, 200], [1, 0.4]);

  return (
    <motion.section style={{ y: parallaxY }}>
      <motion.h1 style={{ opacity: opacityIn }}>
        {/* word-by-word reveal */}
      </motion.h1>
    </motion.section>
  );
}
```

V1 dashboard'da scroll trigger MİNİMAL (data-dense, ciddi UX). V2 marketing'de daha cömert.

---

## 12.6 Decorative Visual Details

### 12.6.1 Paper Texture (Noise Overlay)

Skill'in vurguladığı: "Create atmosphere and depth rather than defaulting to solid colors."

```css
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 1;
  opacity: 0.04;        /* very subtle */
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' /></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>");
  mix-blend-mode: multiply;   /* light mode */
}

[data-theme="dark"] body::before {
  mix-blend-mode: screen;
  opacity: 0.06;
}
```

### 12.6.2 Hairline Dividers

```css
.divider-horizontal {
  height: 0;
  border-top: 0.5px solid var(--stroke-default);
}

/* Editorial column divider — slim vertical line */
.divider-vertical {
  width: 0;
  border-left: 0.5px solid var(--stroke-default);
}

/* Page section break — wider, with optional label */
.section-break {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-block: var(--space-section);
}
.section-break::before,
.section-break::after {
  content: "";
  flex: 1;
  border-top: 0.5px solid var(--stroke-default);
}
.section-break .label {
  font: var(--type-overline);
  color: var(--ink-tertiary);
}
```

### 12.6.3 Ink Stamps

Editorial detail — "approved" hissi veren küçük rotated stamp'ler:

```css
.stamp {
  display: inline-flex;
  padding: 2px 8px;
  font: var(--type-overline);
  border: 1px solid currentColor;
  border-radius: var(--radius-xs);
  color: var(--signal);
  transform: rotate(-2deg);
  letter-spacing: 0.12em;
}
.stamp[data-variant="success"] { color: var(--status-success); }
.stamp[data-variant="warning"] { color: var(--status-warning); }
```

Kullanım: "LIVE", "DRAFT", "REVIEWING", "DIRTY" labels.

### 12.6.4 Marginalia (Editorial Sidenotes)

```css
.marginalia {
  position: absolute;
  right: calc(100% + var(--space-6));
  width: 180px;
  font: var(--type-caption);
  color: var(--ink-tertiary);
  line-height: 1.5;
  border-right: 0.5px solid var(--stroke-default);
  padding-right: var(--space-3);
  text-align: right;
}
```

Settings sayfasında, complex form'ların yanında — "Why this field?" gibi açıklayıcı sidenotes.

### 12.6.5 Iconography

- **Lucide React** — fine 1.5px stroke icons, default
- **Custom Apple/Google logos** — inline SVG, brand renkleriyle
- **Status indicators**: filled circle (4px diameter) renk + label

Kural: Hiçbir icon'a renk **doğrudan** koyma; semantic class kullan (`text-status-success` etc.). Bir icon library içinde **karışık stil** (filled vs outline) **YASAK** — sadece outline.

---

## 12.7 Component Library Anatomy

### 12.7.1 Button

```tsx
// packages/ui/src/Button.tsx
import { cva, type VariantProps } from "class-variance-authority";

const button = cva(
  // base
  "inline-flex items-center justify-center gap-2 font-body font-medium select-none " +
  "transition-all duration-[160ms] [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
  "disabled:opacity-40 disabled:pointer-events-none " +
  "active:scale-[0.97]",
  {
    variants: {
      variant: {
        // Primary — signal accent, only ONE per view ideally
        primary: "bg-[var(--signal)] text-[var(--signal-on)] hover:bg-[var(--signal-hover)] " +
                 "shadow-[var(--shadow-soft)] focus-visible:ring-[var(--signal)]",
        // Secondary — ink outline
        secondary: "bg-[var(--surface-elevated)] text-[var(--ink-primary)] " +
                   "shadow-[var(--shadow-hairline)] hover:bg-[var(--surface-tinted)] " +
                   "focus-visible:ring-[var(--ink-primary)]",
        // Ghost — minimal
        ghost: "bg-transparent text-[var(--ink-primary)] hover:bg-[var(--surface-tinted)]",
        // Destructive — danger color
        destructive: "bg-[var(--status-danger)] text-white hover:opacity-90",
        // Link — text only with underline on hover
        link: "bg-transparent text-[var(--ink-primary)] underline-offset-4 hover:underline p-0 h-auto",
      },
      size: {
        sm: "h-8 px-3 text-[13px] rounded-[var(--radius-sm)]",
        md: "h-9 px-4 text-[13px] rounded-[var(--radius-sm)] tracking-[-0.01em]",
        lg: "h-11 px-6 text-[14px] rounded-[var(--radius)] tracking-[-0.01em]",
        icon: "h-9 w-9 rounded-[var(--radius-sm)]",
      },
      // Editorial detail — primary has a slight tilt on hover
      editorial: {
        true: "hover:-translate-y-[1px]",
      },
    },
    defaultVariants: { variant: "secondary", size: "md", editorial: true },
  }
);

export const Button = ({ variant, size, editorial, className, ...rest }) => (
  <button className={button({ variant, size, editorial, className })} {...rest} />
);
```

### 12.7.2 LocaleChip (Differentiation Component)

```tsx
// packages/ui/src/LocaleChip.tsx
export function LocaleChip({
  locale,
  charCount,
  charLimit,
  state,           // "synced" | "dirty" | "error" | "empty"
  selected,
  onSelect,
}: LocaleChipProps) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "group relative flex items-center gap-3 w-full px-3 py-2.5 text-left rounded-[var(--radius-xs)]",
        "border-l-2 transition-all duration-[160ms]",
        selected
          ? "border-l-[var(--signal)] bg-[var(--signal-tint)]"
          : "border-l-transparent hover:bg-[var(--surface-tinted)]",
      )}
      lang={locale}
    >
      {/* Character sample (editorial detail) */}
      <span className="font-display text-lg leading-none w-7 text-center" style={{ fontVariationSettings: "'opsz' 18, 'wght' 500" }}>
        {localeSample(locale)}
      </span>

      {/* Locale code + name */}
      <span className="flex-1 min-w-0">
        <span className="font-mono text-xs text-[var(--ink-primary)] block">{locale}</span>
        <span className="font-body text-[11px] text-[var(--ink-tertiary)] block truncate">
          {localeName(locale)}
        </span>
      </span>

      {/* Char count or state indicator */}
      <span className="font-mono text-[10px] tabular-nums">
        {state === "empty" ? (
          <span className="text-[var(--ink-tertiary)]">—</span>
        ) : (
          <span className={cn(
            charCount > charLimit ? "text-[var(--status-danger)]" :
            charCount / charLimit > 0.9 ? "text-[var(--status-warning)]" :
            "text-[var(--ink-secondary)]"
          )}>
            {charCount}/{charLimit}
          </span>
        )}
      </span>

      {/* State dot */}
      <StateDot state={state} />
    </button>
  );
}
```

### 12.7.3 PushButton (Split-Action)

```tsx
// packages/ui/src/PushButton.tsx — dropdown ile birleşik primary action
<div className="inline-flex">
  <Button
    variant="primary"
    onClick={onPush}
    className="rounded-r-none border-r border-r-[var(--signal-hover)]"
  >
    <RocketIcon size={14} /> Push to store
  </Button>
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="primary" size="icon" className="rounded-l-none px-2">
        <ChevronDownIcon size={14} />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem onClick={pushCurrentLocale}>
        Push this locale only ({currentLocale})
      </DropdownMenuItem>
      <DropdownMenuItem onClick={pushAllDirty}>
        Push all dirty ({dirtyCount})
      </DropdownMenuItem>
      <DropdownMenuItem onClick={pushAll}>
        Push everything ({totalLocales})
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={previewPush} className="text-[var(--ink-secondary)]">
        <EyeIcon size={14} /> Preview changes…
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</div>
```

### 12.7.4 Card

```tsx
<div className="bg-[var(--surface-elevated)] shadow-[var(--shadow-hairline)] rounded-[var(--radius)] p-6">
  {children}
</div>
```

**Anti-pattern**: drop-shadow + thick border + rounded-2xl = "SaaS card cliché". Bizim card'lar **hairline border + minimal padding + subtle shadow**.

### 12.7.5 StatusDot

```tsx
const STATE_COLORS = {
  synced: "var(--state-synced)",
  dirty: "var(--state-dirty)",
  syncing: "var(--state-syncing)",
  error: "var(--state-error)",
  empty: "var(--ink-quaternary)",
};

export function StateDot({ state, pulse }: { state: keyof typeof STATE_COLORS; pulse?: boolean }) {
  return (
    <span className="relative inline-flex w-2 h-2">
      <span className="absolute inset-0 rounded-full" style={{ background: STATE_COLORS[state] }} />
      {pulse && state === "syncing" && (
        <span
          className="absolute inset-0 rounded-full animate-ping"
          style={{ background: STATE_COLORS[state], opacity: 0.4 }}
        />
      )}
    </span>
  );
}
```

### 12.7.6 CharLimitBar

```tsx
export function CharLimitBar({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100);
  const color =
    value > max ? "var(--status-danger)" :
    pct > 90 ? "var(--status-warning)" :
    pct > 70 ? "var(--ink-secondary)" :
    "var(--ink-quaternary)";
  return (
    <div className="flex items-center gap-3 mt-1">
      <div className="flex-1 h-px bg-[var(--stroke-default)] relative overflow-hidden">
        <motion.div
          initial={false}
          animate={{ width: `${pct}%`, backgroundColor: color }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-y-0 left-0"
        />
      </div>
      <span className="font-mono text-[10px] tabular-nums" style={{ color }}>
        {value}/{max}
      </span>
    </div>
  );
}
```

### 12.7.7 Toast (Sonner)

```tsx
import { Toaster, toast } from "sonner";

// Tailwind config — Sonner unstyled, we apply our tokens
<Toaster
  position="top-right"
  toastOptions={{
    unstyled: true,
    classNames: {
      toast: "flex gap-3 items-start px-4 py-3 bg-[var(--surface-elevated)] " +
             "shadow-[var(--shadow-popover)] rounded-[var(--radius)] w-[360px] " +
             "border-l-2",
      success: "border-l-[var(--status-success)]",
      error: "border-l-[var(--status-danger)]",
      warning: "border-l-[var(--status-warning)]",
      info: "border-l-[var(--status-info)]",
      title: "font-body text-[13px] font-medium text-[var(--ink-primary)]",
      description: "font-body text-[12px] text-[var(--ink-secondary)] mt-1",
    },
  }}
/>

// Usage:
toast.success("Pushed 3 locales", {
  description: "en-US, tr, ja are now live on App Store",
});
```

### 12.7.8 DiffSheet (Differentiation Component)

Push'tan önce ne gönderileceği önizleme:

```tsx
<Sheet open={open} onOpenChange={onClose}>
  <SheetContent side="right" className="w-[640px] sm:max-w-[640px]">
    <SheetHeader>
      <SheetTitle className="font-display text-2xl">
        Preview push to App Store
      </SheetTitle>
      <SheetDescription className="font-body text-sm text-[var(--ink-secondary)]">
        {summary.localeCount} locales • {summary.fieldCount} fields changed
      </SheetDescription>
    </SheetHeader>

    <div className="mt-6 space-y-4">
      {diffs.map((d) => (
        <Accordion key={d.locale} type="single" collapsible>
          <AccordionItem value={d.locale}>
            <AccordionTrigger>
              <div className="flex items-center gap-3 w-full">
                <span className="font-display text-base w-7 text-center">
                  {localeSample(d.locale)}
                </span>
                <span className="font-mono text-xs">{d.locale}</span>
                <span className="ml-auto font-body text-xs text-[var(--ink-secondary)]">
                  {d.changes.length} change{d.changes.length !== 1 && "s"}
                </span>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              {d.changes.map((c) => (
                <FieldDiff key={c.field} field={c.field} before={c.before} after={c.after} />
              ))}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ))}
    </div>

    {/* Unsupported locales warning */}
    {summary.unsupportedGooglePlay.length > 0 && (
      <Alert variant="warning" className="mt-6">
        <Stamp variant="warning">SKIP</Stamp>
        <p className="mt-2 text-sm">
          {summary.unsupportedGooglePlay.length} locale(s) unsupported by Google Play:
          {summary.unsupportedGooglePlay.map((l) => (
            <code key={l} className="font-mono text-xs px-1.5 py-0.5 bg-[var(--surface-sunken)] mx-1">
              {l}
            </code>
          ))}
        </p>
      </Alert>
    )}

    <SheetFooter className="mt-8 gap-3">
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={onConfirm}>
        <RocketIcon size={14} /> Confirm push
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
```

`FieldDiff` component:
```tsx
function FieldDiff({ field, before, after }) {
  // Word-level diff (diff library: "diff" npm)
  const parts = diffWords(before || "", after || "");
  return (
    <div className="border-l-2 border-[var(--stroke-default)] pl-4 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-tertiary)] mb-1">
        {field}
      </div>
      <div className="font-body text-[13px] leading-relaxed">
        {parts.map((p, i) => (
          <span
            key={i}
            className={cn(
              p.added && "bg-[var(--status-success-tint)] text-[var(--status-success)] px-0.5",
              p.removed && "bg-[var(--status-danger-tint)] text-[var(--status-danger)] px-0.5 line-through",
            )}
          >
            {p.value}
          </span>
        ))}
      </div>
    </div>
  );
}
```

---

## 12.8 Iconography Set

Lucide React'tan **seçilmiş subset** (kullanılan ikonlar):

| Icon | Usage |
|------|-------|
| `RocketIcon` | Push primary action |
| `DownloadCloud` | Pull from store |
| `CloudUpload` | Upload screenshot |
| `LanguagesIcon` | Locale picker |
| `ImageIcon` | Screenshot tab |
| `FileVideo` | App preview tab |
| `Package` | Build tab |
| `CheckCircle2` | Success state |
| `AlertTriangle` | Warning state |
| `XCircle` | Error state |
| `Circle` (filled) | StateDot |
| `MoreVertical` | Context menu trigger |
| `ChevronDown` | Dropdown |
| `Search` | Search input |
| `Settings` | Settings link |
| `LogOut` | Sign out |
| `User` | Profile |
| `Building2` | Tenant switcher |
| `Plus` | Add action |
| `Trash2` | Delete |
| `Eye` | Preview |
| `RefreshCcw` | Refresh from store |
| `Sparkles` | Onboarding empty state hero |
| `Command` | Cmd+K palette trigger |

**Custom SVG inline:**
- Apple logo (mono, var(--platform-apple))
- Google Play triangle (var(--platform-google))

---

## 12.9 Loading & Skeleton States

```tsx
// Editorial skeleton — paper texture preserved
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "bg-gradient-to-r from-[var(--surface-sunken)] via-[var(--surface-tinted)] to-[var(--surface-sunken)]",
        "bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite]",
        "rounded-[var(--radius-xs)]",
        className,
      )}
    />
  );
}

// tailwind.config — shimmer keyframe
keyframes: {
  shimmer: { "0%": { "background-position": "200% 0" }, "100%": { "background-position": "-200% 0" }},
},
```

---

## 12.10 Accessibility Tokens

```css
:root {
  /* Focus ring — always visible on keyboard nav */
  --focus-ring: 2px solid var(--signal);
  --focus-ring-offset: 2px;
}

/* Skip-to-content link */
.skip-link {
  position: absolute;
  top: -100px;
  left: 0;
  background: var(--surface-elevated);
  padding: var(--space-3) var(--space-4);
  z-index: 9999;
}
.skip-link:focus { top: 0; }

/* Screen reader only */
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0);
  white-space: nowrap; border: 0;
}
```

**WCAG check'leri CI'da:**
- axe-core her PR'da otomatik
- Lighthouse a11y > 95 hedef
- Contrast checker (`@adobe/leonardo-contrast-colors`) tüm token kombinasyonları validate

---

## 12.11 Tailwind Config (özet)

```js
// tailwind.config.ts
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
  darkMode: ["selector", "[data-theme='dark']"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
        mono: ["var(--font-mono)"],
      },
      colors: {
        // CSS var bridge — use directly via bracket: bg-[var(--surface-paper)]
      },
      spacing: {
        // CSS var bridge
      },
      keyframes: {
        "editorial-reveal": {
          "0%": { opacity: "0", transform: "translateY(8px)", filter: "blur(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)", filter: "blur(0)" },
        },
        shimmer: { /* ... */ },
        "stamp-bump": { /* ... */ },
      },
      animation: {
        "editorial-reveal": "editorial-reveal 380ms cubic-bezier(0.16, 1, 0.3, 1) both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
```

---

## 12.12 Decision Reasoning (her ana token için niçin)

| Token | Niye |
|-------|------|
| Paper white `#FAF8F2` | Cool gray ya da pure white "SaaS cookie cutter". Warm paper printing-press hissi verir. |
| Ink `#0E0E0C` | Pure black (#000) parlak ekranda yorucu; warm ink karakter verir. |
| Signal `#E84B1E` | Rebellious yet warm. Vermilion ink stamp hissi. Tek aksanlı sistem'in karakter merkezi. |
| Fraunces | Optical sizing + variable axes + non-overused + multi-language coverage |
| Geist | Tabular nums default + Türkçe destek + Inter olmamak |
| IBM Plex Mono | Apache 2.0, Türkçe karakter, "technical trust" |
| 2px radius | "Soft 12px radius" SaaS cliché. Editorial = sharp corners + paper texture. |
| Hairline 0.5px borders | Print magazine line weight; 1px+ feels "web cliché" |
| Asymmetric grid | Swiss editorial heritage; pure 12-equal-col grid = generic |
| Locale character chip | Functional + decorative — kullanıcının dil seçimini bedensel olarak hissetmesi |
| Diff sheet primary UX | Skill'in vurguladığı "unforgettable element" — kullanıcı bunu hatırlar |
| Single signal accent | Skill'in "dominant + sharp accent" prensibi |
| Soft → Slow → Deliberate motion tempo | Editorial sayfa açılışı hissi |
| Light + Dark warm tones | Pure black/white "AI generated" cliché |

---

## 12.13 What Will NOT Appear (Anti-Pattern List)

Bu tasarım sisteminde **görmek YASAK**:

- ❌ Inter, Roboto, Arial, system-ui font
- ❌ Pure black (`#000000`) veya pure white (`#FFFFFF`) sayfa zemini
- ❌ Mor → pembe gradient anywhere
- ❌ Glassmorphism (backdrop-filter: blur)
- ❌ Neumorphism (soft inset shadows)
- ❌ Skeuomorphism (textures imitating physical materials)
- ❌ Rainbow palettes (4+ semantic colors yan yana)
- ❌ Material Design ripple effect
- ❌ Bootstrap utility class isimleri (`btn-primary`, `card-header`)
- ❌ Default Tailwind component patterns (Catalyst defaults)
- ❌ Lottie animations
- ❌ Avatar squares (her avatar circle)
- ❌ Stock illustrations (unDraw, Storyset)
- ❌ Emoji icon system (real icon library kullan)
- ❌ Cookie banner default styling (custom build et)
- ❌ Animated illustrations as hero (statik elegant tek-line drawing OK)
- ❌ "Powered by X" badges
- ❌ Modal'larda büyük X close button (text "Cancel" link OK)
- ❌ Toast'larda emoji (`✅`, `❌` etc.) — typography + color yeter
- ❌ Loading spinner default (`<svg class="animate-spin">`) — custom kademe-pulse
- ❌ Default placeholder text ("Lorem ipsum") production'a sızması
- ❌ Çoklu accent rakipleşmesi (örn. button da yeşil, link de yeşil)
