/**
 * resolveLocalProjectPath — pins MARQ-023: a user-supplied local build path
 * must be absolute, must resolve (realpath) to a real directory, and — when
 * BUILDS_LOCAL_ROOT is configured — must live inside that root. This is the
 * guard that stops a MAINTAINER pointing a shared runner at another tenant's
 * checkout or a malicious gradlew dir.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalProjectPath } from "../processBuildRun";

describe("resolveLocalProjectPath — MARQ-023", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mq-builds-root-"));
  });
  afterEach(() => {
    delete process.env.BUILDS_LOCAL_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects a relative path", async () => {
    await expect(resolveLocalProjectPath("relative/path")).rejects.toThrow(/absolute/i);
  });

  test("rejects a non-existent absolute path", async () => {
    await expect(resolveLocalProjectPath(join(root, "nope"))).rejects.toThrow(/not found/i);
  });

  test("accepts an existing absolute path when no BUILDS_LOCAL_ROOT is set", async () => {
    const proj = join(root, "proj");
    mkdirSync(proj);
    const resolved = await resolveLocalProjectPath(proj);
    expect(resolved).toContain("proj");
  });

  test("with BUILDS_LOCAL_ROOT set, accepts a path INSIDE the root", async () => {
    process.env.BUILDS_LOCAL_ROOT = root;
    const proj = join(root, "inside");
    mkdirSync(proj);
    const resolved = await resolveLocalProjectPath(proj);
    expect(resolved).toContain("inside");
  });

  test("with BUILDS_LOCAL_ROOT set, REJECTS a path outside the root", async () => {
    process.env.BUILDS_LOCAL_ROOT = root;
    const outside = mkdtempSync(join(tmpdir(), "mq-outside-"));
    try {
      await expect(resolveLocalProjectPath(outside)).rejects.toThrow(
        /outside the allowed builds root/i,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
