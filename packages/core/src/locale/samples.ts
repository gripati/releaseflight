/**
 * Per-locale typographic samples for the LocaleChip differentiation
 * component. See docs/12_DESIGN_SYSTEM.md §12.3.5.
 *
 * The two-character sample shows the user a glimpse of the writing system,
 * so the locale list feels embodied rather than just code-shaped.
 */
const SAMPLES: Readonly<Record<string, string>> = {
  // Latin
  en: "Aa", tr: "Aş", es: "Áa", fr: "Àe", de: "Äo", it: "Èa", pt: "Çã",
  nl: "Ée", sv: "Åa", da: "Øe", no: "Æa", fi: "Ää", pl: "Łę", cs: "Čř",
  sk: "Šľ", hu: "Őű", ro: "Ăț", hr: "Čš", uk: "Юя", ca: "Ça",
  vi: "Ăà", id: "Aa", ms: "Aa", tl: "Aa", sw: "Aa", fil: "Aa",
  af: "Aa", sq: "Aa", et: "Õä", lt: "Ųė", lv: "Ļš",

  // Cyrillic
  ru: "Яб", be: "Йд", bg: "Бг", mk: "Љш", sr: "Ћш", mn: "Өү",

  // CJK
  ja: "あ", ko: "한", "zh-Hans": "字", "zh-CN": "字",
  "zh-Hant": "繁", "zh-TW": "繁", "zh-HK": "繁",

  // South & Southeast Asian
  hi: "अब", bn: "অব", gu: "અબ", kn: "ಅಬ", ml: "അബ",
  mr: "अब", pa: "ਅਬ", ta: "அப", te: "అబ", si: "අබ",
  ne: "अब", th: "กข", lo: "ກຂ", km: "កខ", my: "ကခ",

  // RTL
  ar: "أب", he: "אב", fa: "ابر", ur: "ابر",

  // Caucasian
  ka: "აბ", hy: "Աբ", az: "Aa",

  // Other
  el: "Αβ", is: "Áa", eu: "Aa", gl: "Áa", am: "ሀለ", sw_KE: "Aa",
};

export function localeSample(locale: string): string {
  return SAMPLES[locale] ?? SAMPLES[locale.split("-")[0] ?? ""] ?? "Aa";
}
