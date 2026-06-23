import { describe, expect, test } from "vitest";
import { parseStorageKey, tenantScratchKey, tenantStorageKey } from "../keys";

const TENANT = "11111111-1111-4111-8111-111111111111";

describe("tenantStorageKey", () => {
  test("builds canonical tenant-prefixed path", () => {
    expect(tenantStorageKey(TENANT, "apps", "abc", "screenshots", "1.png")).toBe(
      `tenants/${TENANT}/apps/abc/screenshots/1.png`,
    );
  });

  test("rejects path traversal in extra segments", () => {
    expect(() => tenantStorageKey(TENANT, "..", "secret")).toThrow();
    expect(() => tenantStorageKey(TENANT, "apps/foo")).toThrow();
  });

  test("rejects non-UUID tenantId", () => {
    expect(() => tenantStorageKey("not-a-uuid", "x")).toThrow();
  });

  test("scratch key has scratch prefix", () => {
    expect(tenantScratchKey(TENANT, "abc.tmp")).toBe(`scratch/${TENANT}/abc.tmp`);
  });
});

describe("parseStorageKey", () => {
  test("extracts tenantId from tenant-scoped key", () => {
    expect(parseStorageKey(`tenants/${TENANT}/apps/abc/foo.png`)).toEqual({
      tenantId: TENANT,
      rest: ["apps", "abc", "foo.png"],
    });
  });

  test("returns null tenantId for non-tenant keys", () => {
    expect(parseStorageKey("scratch/x.tmp").tenantId).toBeNull();
  });
});
