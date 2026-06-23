import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

/**
 * Pins the self-host fix: the build-artifact route MUST stream bytes through the
 * same-origin Next server (Content-Disposition download) and MUST NOT hand the
 * browser a raw `storage.signedGetUrl()` — on self-host that URL points at the
 * internal `http://minio:9000`, unreachable from the browser / Tauri webview.
 */

const findFirst = vi.fn();
const getStream = vi.fn();
const signedGetUrl = vi.fn();

vi.mock("@marquee/db", () => ({
  prisma: { build: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

vi.mock("@marquee/storage", () => ({
  storage: {
    getStream: (...a: unknown[]) => getStream(...a),
    signedGetUrl: (...a: unknown[]) => signedGetUrl(...a),
  },
}));

vi.mock("@/lib/auth", () => ({
  requireTenant: vi.fn(async () => ({ tenantId: "t1" })),
  // withTenantContext just runs the callback (RLS scoping is exercised in the
  // db integration suite, not here).
  withTenantContext: (fn: () => unknown) => fn(),
}));

import { GET } from "../route";

function ctx(params: { id: string; buildId: string }) {
  return { params: Promise.resolve(params) };
}

beforeEach(() => {
  findFirst.mockReset();
  getStream.mockReset();
  signedGetUrl.mockReset();
});

describe("build artifact route", () => {
  it("streams the artifact as a same-origin download and never returns a presigned URL", async () => {
    findFirst.mockResolvedValue({
      id: "b1",
      appId: "a1",
      artifactStorageKey: "tenants/t1/apps/a1/builds/b1/artifact.apk",
      artifactKind: "APK",
      platform: "ANDROID",
      versionString: "1.2.3",
      buildNumber: "42",
    });
    const bytes = Buffer.from("PK\x03\x04 fake-apk");
    getStream.mockResolvedValue({
      body: Readable.from([bytes]),
      contentType: "application/vnd.android.package-archive",
      size: bytes.length,
    });

    const res = await GET(new Request("http://x/") as never, ctx({ id: "a1", buildId: "b1" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="android-v1.2.3-b42.apk"',
    );
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    // The raw presigned-URL path must NOT be taken.
    expect(signedGetUrl).not.toHaveBeenCalled();
    // Body is the streamed artifact, not a JSON `{ url }`.
    const out = Buffer.from(await res.arrayBuffer());
    expect(out.equals(bytes)).toBe(true);
  });

  it("sanitises user/git-influenced fields in the download filename", async () => {
    findFirst.mockResolvedValue({
      id: "b1",
      appId: "a1",
      artifactStorageKey: "tenants/t1/apps/a1/builds/b1/artifact.ipa",
      artifactKind: "IPA",
      platform: "IOS",
      versionString: '1.0"; rm -rf', // hostile value
      buildNumber: "9\r\n",
    });
    getStream.mockResolvedValue({
      body: Readable.from([Buffer.from("x")]),
      contentType: undefined,
      size: 1,
    });

    const res = await GET(new Request("http://x/") as never, ctx({ id: "a1", buildId: "b1" }));
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).not.toMatch(/[\r\n]/);
    // Only one quoted filename token — no injected quotes/segments.
    expect(cd).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("404s when the build has no artifact", async () => {
    findFirst.mockResolvedValue({ id: "b1", appId: "a1", artifactStorageKey: null });

    const res = await GET(new Request("http://x/") as never, ctx({ id: "a1", buildId: "b1" }));
    expect(res.status).toBe(404);
    expect(getStream).not.toHaveBeenCalled();
    expect(signedGetUrl).not.toHaveBeenCalled();
  });

  it("404s when the object is missing from the store", async () => {
    findFirst.mockResolvedValue({
      id: "b1",
      appId: "a1",
      artifactStorageKey: "tenants/t1/apps/a1/builds/b1/artifact.aab",
      artifactKind: "AAB",
      platform: "ANDROID",
    });
    getStream.mockRejectedValue(Object.assign(new Error("missing"), { name: "NoSuchKey" }));

    const res = await GET(new Request("http://x/") as never, ctx({ id: "a1", buildId: "b1" }));
    expect(res.status).toBe(404);
  });
});
