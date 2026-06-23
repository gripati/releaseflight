/**
 * Whether auth/CSRF cookies should carry the `Secure` attribute.
 *
 * Browsers silently DROP `Secure` cookies sent over plain http, so a self-host
 * deployment served on http://localhost:3000 must NOT mark the `gp_csrf` or
 * session cookies Secure — otherwise neither cookie ever persists, every
 * mutating request fails with "CSRF token missing", and the session never
 * sticks after login.
 *
 * We key off the deployment's public URL (APP_URL): Secure UNLESS APP_URL is
 * explicitly `http://`. So a TLS deployment (https) keeps Secure cookies, a
 * self-host box (http://localhost) drops the flag, and a missing/unusual
 * APP_URL still defaults to Secure in production (fail-safe — never silently
 * downgrade a real https deployment). Non-production is never Secure (local dev).
 */
export function useSecureCookies(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  return !(process.env.APP_URL ?? "").startsWith("http://");
}
