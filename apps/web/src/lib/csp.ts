/**
 * Content-Security-Policy builder (Edge-safe — pure string assembly, no Node
 * APIs) shared by the middleware. A per-request nonce lets production drop
 * `'unsafe-inline'` from `script-src` entirely: Next.js stamps the nonce on its
 * own framework <script> tags, and our one hand-written inline script (the theme
 * bootstrap in app/layout.tsx) carries it too. `'strict-dynamic'` in production
 * additionally makes the browser ignore host-based script sources — so a
 * same-origin file (e.g. a user upload served by the storage proxy) can never be
 * loaded as a script. Development keeps `'unsafe-eval'` (Next Fast Refresh/HMR).
 */

// App Store Connect + Google Play hosts that serve the pre-signed image/video
// URLs rendered directly by the browser (img/media only — never scripts).
const STORE_CDN = [
  // Apple
  "https://*.mzstatic.com",
  "https://devimages-cdn.apple.com",
  "https://*.devimages-cdn.apple.com",
  "https://apptrailers.itunes.apple.com",
  "https://*.itunes.apple.com",
  "https://*.apple.com",
  // Google
  "https://*.googleusercontent.com",
  "https://play-lh.googleusercontent.com",
  "https://*.googleapis.com",
  "https://lh3.ggpht.com",
  "https://*.ggpht.com",
  "https://*.gstatic.com",
].join(" ");

export interface CspOptions {
  nonce: string;
  isProd: boolean;
  /**
   * Whether the app is actually served over HTTPS. Gates
   * `upgrade-insecure-requests`: emitting that directive on a plaintext
   * deployment (e.g. a self-host box on http://localhost:3000) makes the browser
   * rewrite every http subresource — /_next/*.css, *.js — to https, which has no
   * TLS listener, so all assets fail and the page renders unstyled/non-interactive.
   * Defaults to true so a TLS deployment (and existing callers/tests) upgrade as
   * before; the middleware passes false when the request scheme is plain http.
   */
  secure?: boolean;
}

export function buildCsp({ nonce, isProd, secure = true }: CspOptions): string {
  const extraConnect = process.env.CSP_EXTRA_CONNECT ?? "";
  const extraImg = process.env.CSP_EXTRA_IMG ?? "";
  const extraScript = process.env.CSP_EXTRA_SCRIPT ?? "";

  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    // strict-dynamic: trust scripts loaded by a nonce'd script, ignore host
    // allowlists + unsafe-inline. Production only.
    isProd ? "'strict-dynamic'" : "",
    // Dev-only: Next's Fast Refresh runtime uses new Function(...).
    !isProd ? "'unsafe-eval'" : "",
    // Dev-only fallback (a nonce already disables unsafe-inline in modern
    // browsers; this just keeps older dev tooling happy). Never in prod.
    !isProd ? "'unsafe-inline'" : "",
    extraScript,
  ]
    .filter(Boolean)
    .join(" ");

  const connectSrc = ["'self'", !isProd ? "ws: wss:" : "", extraConnect]
    .filter(Boolean)
    .join(" ");

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src 'self' data: blob: ${STORE_CDN} ${extraImg}`.trim(),
    `media-src 'self' blob: ${STORE_CDN}`,
    `connect-src ${connectSrc}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    // Only when actually served over HTTPS — see CspOptions.secure.
    isProd && secure ? "upgrade-insecure-requests" : "",
  ]
    .filter(Boolean)
    .join("; ");
}
