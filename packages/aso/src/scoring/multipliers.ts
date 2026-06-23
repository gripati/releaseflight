/**
 * Scoring multipliers shared between persistence (`keywordScore`) and
 * proposal ranking (`scoreAstroCandidate`).
 *
 * Before the 2026-05 audit, language-match + multi-word boosts were
 * only applied during candidate ranking — the DB-persisted score on
 * `KeywordSignal` ignored them. Result: the same Czech keyword
 * `řezat` scored 0.55 in proposal ranking but 0.45 in the persisted
 * row, and the UI surfaced the lower number. Centralising the
 * multipliers fixes the divergence: callers pass `keyword` +
 * `localeHint` and both scoring paths get the same answer.
 */

/** Long-tail multiplier — single-word terms are penalised, 2-word
 *  reasonably boosted, 3+ word strongly boosted. A 3-word long-tail
 *  has materially higher niche-ASO value than a 1-word generic at
 *  the same Apple popularity. */
export function multiWordBoost(keyword: string): number {
  const wordCount = keyword.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 1) return 0.85;
  if (wordCount === 2) return 1.05;
  return 1.15;
}

/**
 * Language-match multiplier for a candidate keyword against a target
 * locale. Returns:
 *   • 1.10 for candidates that strongly match the locale's expected
 *     script + character class (e.g. Czech diacritics for `cs`,
 *     Cyrillic for `ru`, Hiragana/Katakana for `ja`).
 *   • 1.00 for ambiguous candidates (Latin ASCII for any Latin locale).
 *   • 0.45 for clear script mismatches (Latin candidate for `ja`, etc.) —
 *     these almost never belong even though Astro returns them.
 *
 * Latin-only locales (en, de, fr, es, it, pt, nl, …) accept any Latin
 * candidate at 1.0; we only soft-boost when the language has
 * distinctive characters (diacritics, ligatures) so locale-specific
 * candidates float to the top while English-flavoured Astro results
 * still surface.
 */
export function localeLanguageMultiplier(keyword: string, locale: string): number {
  const lc = locale.toLowerCase().split(/[-_]/)[0] ?? "";
  const scripts = detectScripts(keyword);

  switch (lc) {
    // ── Non-Latin scripts — strong filter ──────────────────────────
    case "ja":
      return scripts.cjk || scripts.kana ? 1.1 : 0.45;
    case "ko":
      return scripts.hangul ? 1.1 : 0.45;
    case "zh":
      return scripts.cjk ? 1.1 : 0.45;
    case "ru":
    case "uk":
    case "bg":
    case "sr":
      return scripts.cyrillic ? 1.1 : 0.45;
    case "ar":
    case "fa":
    case "he":
      return scripts.arabicOrHebrew ? 1.1 : 0.45;
    case "th":
      return scripts.thai ? 1.1 : 0.45;
    case "hi":
    case "ta":
    case "te":
    case "kn":
    case "ml":
    case "bn":
      return scripts.devanagariOrIndic ? 1.1 : 0.45;

    // ── Latin locales with distinctive diacritics — soft boost ─────
    case "cs":
      return /[áčďéěíňóřšťúůýž]/i.test(keyword) ? 1.1 : 0.85;
    case "sk":
      return /[áäčďéíĺľňóôŕšťúýž]/i.test(keyword) ? 1.1 : 0.85;
    case "pl":
      return /[ąćęłńóśźż]/i.test(keyword) ? 1.1 : 0.85;
    case "hu":
      return /[áéíóöőúüű]/i.test(keyword) ? 1.1 : 0.85;
    case "ro":
      return /[ăâîșț]/i.test(keyword) ? 1.1 : 0.85;
    case "hr":
    case "bs":
      return /[čćđšž]/i.test(keyword) ? 1.1 : 0.85;
    case "tr":
      return /[çğıöşü]/i.test(keyword) ? 1.1 : 0.85;
    case "de":
      return /[äöüß]/i.test(keyword) ? 1.1 : 0.95;
    case "fr":
      return /[àâçéèêëîïôûüùÿœæ]/i.test(keyword) ? 1.1 : 0.95;
    case "es":
      return /[áéíóúñ¿¡]/i.test(keyword) ? 1.1 : 0.95;
    case "pt":
      return /[áàâãçéêíóôõú]/i.test(keyword) ? 1.1 : 0.95;
    case "it":
      return /[àèéìíîòóùú]/i.test(keyword) ? 1.1 : 0.95;
    case "vi":
      return /[ăâđêôơưáàảãạ]/i.test(keyword) ? 1.1 : 0.85;
    case "el":
      return /\p{Script=Greek}/u.test(keyword) ? 1.1 : 0.45;

    // ── Default (en, generic Latin) ────────────────────────────────
    default:
      return 1.0;
  }
}

interface ScriptFlags {
  cjk: boolean;
  kana: boolean;
  hangul: boolean;
  cyrillic: boolean;
  arabicOrHebrew: boolean;
  thai: boolean;
  devanagariOrIndic: boolean;
}

function detectScripts(s: string): ScriptFlags {
  return {
    cjk: /\p{Script=Han}/u.test(s),
    kana: /\p{Script=Hiragana}|\p{Script=Katakana}/u.test(s),
    hangul: /\p{Script=Hangul}/u.test(s),
    cyrillic: /\p{Script=Cyrillic}/u.test(s),
    arabicOrHebrew: /\p{Script=Arabic}|\p{Script=Hebrew}/u.test(s),
    thai: /\p{Script=Thai}/u.test(s),
    devanagariOrIndic: /\p{Script=Devanagari}|\p{Script=Tamil}|\p{Script=Telugu}|\p{Script=Kannada}|\p{Script=Malayalam}|\p{Script=Bengali}/u.test(s),
  };
}
