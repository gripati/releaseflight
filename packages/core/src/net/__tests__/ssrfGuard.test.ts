import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyIp, assertSafeOutboundUrl, assertSafeMcpEndpoint } from "../ssrfGuard";
import { ValidationError } from "../../errors";

/**
 * Pins the SSRF guard so the metadata/link-local/loopback/private denials and
 * the allowlist short-circuit can't silently regress. Uses literal IPs (no DNS)
 * everywhere possible; the only hostname used is `localhost`, which resolves to
 * loopback on every reasonable test host.
 */

describe("classifyIp() — IPv4", () => {
  test("127.x is loopback", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("127.255.255.254")).toBe("loopback");
  });

  test("169.254.169.254 cloud metadata is link-local", () => {
    expect(classifyIp("169.254.169.254")).toBe("link-local");
  });

  test("169.254.x.x is link-local", () => {
    expect(classifyIp("169.254.0.1")).toBe("link-local");
  });

  test("0.0.0.0 (0.0.0.0/8) is link-local", () => {
    expect(classifyIp("0.0.0.0")).toBe("link-local");
  });

  test("10.x is private", () => {
    expect(classifyIp("10.0.0.1")).toBe("private");
  });

  test("172.16-31.x is private", () => {
    expect(classifyIp("172.16.0.1")).toBe("private");
    expect(classifyIp("172.31.255.255")).toBe("private");
  });

  test("172.15.x and 172.32.x are NOT private (public)", () => {
    expect(classifyIp("172.15.0.1")).toBe("public");
    expect(classifyIp("172.32.0.1")).toBe("public");
  });

  test("192.168.x is private", () => {
    expect(classifyIp("192.168.1.1")).toBe("private");
  });

  test("100.64-127.x CGNAT is private", () => {
    expect(classifyIp("100.64.0.1")).toBe("private");
    expect(classifyIp("100.127.255.255")).toBe("private");
  });

  test("8.8.8.8 is public", () => {
    expect(classifyIp("8.8.8.8")).toBe("public");
  });
});

describe("classifyIp() — IPv6", () => {
  test("::1 is loopback", () => {
    expect(classifyIp("::1")).toBe("loopback");
  });

  test("fe80:: link-local", () => {
    expect(classifyIp("fe80::1")).toBe("link-local");
  });

  test("fc00::/fd00:: ULA is private", () => {
    expect(classifyIp("fc00::1")).toBe("private");
    expect(classifyIp("fd12:3456:789a::1")).toBe("private");
  });

  test("::ffff:10.0.0.1 mapped resolves to embedded v4 (private)", () => {
    expect(classifyIp("::ffff:10.0.0.1")).toBe("private");
  });

  test("ff02:: multicast is link-local", () => {
    expect(classifyIp("ff02::1")).toBe("link-local");
  });

  test("2606:: is public", () => {
    expect(classifyIp("2606:4700:4700::1111")).toBe("public");
  });
});

describe("assertSafeOutboundUrl()", () => {
  test("rejects non-http(s) scheme", async () => {
    await expect(assertSafeOutboundUrl("ftp://8.8.8.8/x")).rejects.toBeInstanceOf(ValidationError);
    await expect(assertSafeOutboundUrl("file:///etc/passwd")).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects an invalid URL", async () => {
    await expect(assertSafeOutboundUrl("not a url")).rejects.toThrow(ValidationError);
    await expect(assertSafeOutboundUrl("not a url")).rejects.toThrow(/Invalid URL/);
  });

  test("BLOCKS http://169.254.169.254 (cloud metadata)", async () => {
    await expect(assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      ValidationError,
    );
  });

  test("BLOCKS a private literal by default (allowPrivate=false)", async () => {
    await expect(assertSafeOutboundUrl("http://10.0.0.1/")).rejects.toThrow(ValidationError);
    await expect(assertSafeOutboundUrl("http://192.168.1.1/")).rejects.toThrow(/private/i);
  });

  test("ALLOWS a private literal when allowPrivate=true", async () => {
    await expect(
      assertSafeOutboundUrl("http://10.0.0.1/", { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });

  test("ALLOWS http://127.0.0.1 when allowLoopback default (true)", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1:8080/")).resolves.toBeUndefined();
  });

  test("BLOCKS http://127.0.0.1 when allowLoopback=false", async () => {
    await expect(
      assertSafeOutboundUrl("http://127.0.0.1:8080/", { allowLoopback: false }),
    ).rejects.toThrow(/loopback/i);
  });

  test("ALLOWS a public IP literal", async () => {
    await expect(assertSafeOutboundUrl("https://8.8.8.8/")).resolves.toBeUndefined();
  });

  test("allowedHosts: allows a listed host (short-circuits IP checks)", async () => {
    // 169.254.169.254 would normally be blocked, but an explicit allowlist
    // entry is trusted by the operator and short-circuits classification.
    await expect(
      assertSafeOutboundUrl("http://169.254.169.254/", { allowedHosts: ["169.254.169.254"] }),
    ).resolves.toBeUndefined();
  });

  test("allowedHosts: rejects an unlisted host", async () => {
    await expect(
      assertSafeOutboundUrl("https://8.8.8.8/", { allowedHosts: ["example.com"] }),
    ).rejects.toThrow(/allowlist/i);
  });

  test("allowedHosts matching is case-insensitive", async () => {
    await expect(
      assertSafeOutboundUrl("https://Example.COM/path", { allowedHosts: ["example.com"] }),
    ).resolves.toBeUndefined();
  });
});

describe("assertSafeMcpEndpoint()", () => {
  const ORIGINAL_ENV = process.env.ASO_MCP_ALLOWED_HOSTS;

  beforeEach(() => {
    delete process.env.ASO_MCP_ALLOWED_HOSTS;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ASO_MCP_ALLOWED_HOSTS;
    } else {
      process.env.ASO_MCP_ALLOWED_HOSTS = ORIGINAL_ENV;
    }
  });

  test("allows loopback (Astro Desktop default) with no allowlist set", async () => {
    await expect(assertSafeMcpEndpoint("http://localhost:3001/mcp")).resolves.toBeUndefined();
    await expect(assertSafeMcpEndpoint("http://127.0.0.1:3001/mcp")).resolves.toBeUndefined();
  });

  test("honours ASO_MCP_ALLOWED_HOSTS: allows a listed host", async () => {
    vi.stubEnv("ASO_MCP_ALLOWED_HOSTS", "mcp.internal.example, other.example");
    await expect(assertSafeMcpEndpoint("https://mcp.internal.example/mcp")).resolves.toBeUndefined();
  });

  test("honours ASO_MCP_ALLOWED_HOSTS: rejects an unlisted host", async () => {
    vi.stubEnv("ASO_MCP_ALLOWED_HOSTS", "mcp.internal.example");
    await expect(assertSafeMcpEndpoint("https://8.8.8.8/mcp")).rejects.toThrow(/allowlist/i);
  });

  test("blocks cloud metadata when no allowlist is configured", async () => {
    await expect(assertSafeMcpEndpoint("http://169.254.169.254/")).rejects.toThrow(ValidationError);
  });
});
