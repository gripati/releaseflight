/**
 * SSRF guard for server-side fetches to user-supplied URLs.
 *
 * Before the server fetches a URL a user controls (e.g. the ASO research MCP
 * `endpoint`), call {@link assertSafeOutboundUrl}. It validates the scheme and
 * resolves the hostname, rejecting cloud-metadata / link-local / loopback /
 * private addresses unless the policy explicitly allows them. This blocks the
 * classic SSRF targets (169.254.169.254 metadata, internal admin APIs).
 *
 * Residual caveat: we resolve-and-validate here, but the subsequent fetch
 * re-resolves the name, so a DNS-rebinding attacker with a sub-second TTL could
 * still swing the second lookup to an internal IP. The metadata/link-local
 * denial closes the highest-value target; for full rebinding safety an operator
 * should also use an explicit `allowedHosts` allowlist.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";
import { ValidationError } from "../errors";

export interface SsrfPolicy {
  /** Exact hostname allowlist (case-insensitive). When set, only these hosts pass. */
  allowedHosts?: string[];
  /** Allow 127.0.0.0/8 + ::1. Default true (the documented Astro Desktop target). */
  allowLoopback?: boolean;
  /** Allow RFC1918 / ULA / CGNAT ranges. Default false. */
  allowPrivate?: boolean;
  /** Permitted URL schemes. Default ["http:", "https:"]. */
  schemes?: string[];
}

type IpClass = "loopback" | "link-local" | "private" | "public";

export async function assertSafeOutboundUrl(rawUrl: string, policy: SsrfPolicy = {}): Promise<void> {
  const schemes = policy.schemes ?? ["http:", "https:"];
  const allowLoopback = policy.allowLoopback ?? true;
  const allowPrivate = policy.allowPrivate ?? false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError("Invalid URL");
  }
  if (!schemes.includes(url.protocol)) {
    throw new ValidationError(`Blocked URL scheme: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) throw new ValidationError("URL has no host");

  if (policy.allowedHosts && policy.allowedHosts.length > 0) {
    const ok = policy.allowedHosts.some((h) => h.toLowerCase() === host);
    if (!ok) throw new ValidationError(`Host not in allowlist: ${host}`);
    // An explicitly allowlisted host is trusted by the operator.
    return;
  }

  const addresses = await resolveAddresses(host);
  if (addresses.length === 0) throw new ValidationError(`Could not resolve host: ${host}`);

  for (const ip of addresses) {
    const cls = classifyIp(ip);
    if (cls === "link-local") {
      throw new ValidationError(`Blocked link-local/metadata address for ${host}`);
    }
    if (cls === "loopback" && !allowLoopback) {
      throw new ValidationError(`Blocked loopback address for ${host}`);
    }
    if (cls === "private" && !allowPrivate) {
      throw new ValidationError(`Blocked private/internal address for ${host}`);
    }
  }
}

/**
 * SSRF guard specialised for the ASO research MCP endpoint. Call this from
 * SERVER code (route handler / worker) before handing the endpoint to
 * AstroMcpClient — NOT from inside the aso package, whose barrel is reachable
 * from client bundles (importing node:dns there breaks the web build). Honours
 * the `ASO_MCP_ALLOWED_HOSTS` allowlist and permits the loopback Astro Desktop
 * default.
 */
export async function assertSafeMcpEndpoint(endpoint: string): Promise<void> {
  const allow = (process.env.ASO_MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await assertSafeOutboundUrl(endpoint, {
    allowedHosts: allow.length > 0 ? allow : undefined,
    allowLoopback: true,
  });
}

async function resolveAddresses(host: string): Promise<string[]> {
  if (net.isIP(host) !== 0) return [host];
  try {
    const results = await lookup(host, { all: true });
    return results.map((r) => r.address);
  } catch {
    // Resolution failure → caller treats empty as "unresolvable" (blocked).
    return [];
  }
}

/** Classify an IP literal into a coarse reachability class. */
export function classifyIp(ip: string): IpClass {
  const v = net.isIP(ip);
  if (v === 4) return classifyV4(ip);
  if (v === 6) return classifyV6(ip);
  // Not an IP — shouldn't happen (resolveAddresses only yields IPs); be safe.
  return "link-local";
}

function classifyV4(ip: string): IpClass {
  const p = ip.split(".").map((n) => Number(n));
  const [a = 0, b = 0] = p;
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local"; // includes 169.254.169.254 metadata
  if (a === 0) return "link-local"; // 0.0.0.0/8 "this network"
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT 100.64.0.0/10
  return "public";
}

function classifyV6(ip: string): IpClass {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded v4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return classifyV4(mapped[1]);
  if (lower === "::1") return "loopback";
  if (lower === "::") return "link-local";
  if (lower.startsWith("fe80")) return "link-local"; // fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "private"; // fc00::/7 ULA
  if (lower.startsWith("ff")) return "link-local"; // multicast — never a valid fetch target
  return "public";
}
