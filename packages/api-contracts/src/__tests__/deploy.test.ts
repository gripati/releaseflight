import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GitRepoUrl,
  GitRef,
  UpdateConnectionRequest,
  DeployRequest,
  UpdateBuildConfigRequest,
} from "../deploy";

// These tests pin the authenticated-to-RCE hardening on the Deploy/Build-Ship
// git contracts: the runner clones whatever repoUrl/gitRef is stored, so the
// schemas must reject git's command-executing transports (`::` => ext::/fd::),
// option-injection (leading `-`), and non-git URL schemes (file://). The
// UpdateConnectionRequest case is the specific bug: a loose update body used to
// let a bad `ext::` repoUrl through after creation.

// Keep deterministic: no network/DNS — all inputs are literal strings. Stub and
// restore process.env so the suite can't leak env mutation into siblings.
const savedEnv = { ...process.env };
beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...savedEnv };
});

describe("GitRepoUrl", () => {
  const accepts = [
    "git@github.com:org/repo.git",
    "https://github.com/org/repo",
  ];
  for (const url of accepts) {
    test(`accepts ${url}`, () => {
      expect(GitRepoUrl.safeParse(url).success).toBe(true);
    });
  }

  const rejects: Array<[string, string]> = [
    ["ext:: command transport (RCE)", "ext::sh -c id"],
    ["fd:: file-descriptor transport", "fd::17/foo"],
    ["option injection (leading -)", "-oProxyCommand=evil"],
    ["file:// scheme", "file:///etc/passwd"],
  ];
  for (const [label, url] of rejects) {
    test(`rejects ${label}`, () => {
      expect(GitRepoUrl.safeParse(url).success).toBe(false);
    });
  }

  test("rejects a string longer than 512 chars (length cap)", () => {
    const long = "https://github.com/org/" + "a".repeat(600);
    expect(long.length).toBeGreaterThan(512);
    expect(GitRepoUrl.safeParse(long).success).toBe(false);
  });
});

describe("GitRef", () => {
  const accepts = ["main", "release/1.2", "v1.0.0"];
  for (const ref of accepts) {
    test(`accepts ${ref}`, () => {
      expect(GitRef.safeParse(ref).success).toBe(true);
    });
  }

  const rejects: Array<[string, string]> = [
    ["leading dash (option injection)", "-x"],
    ["embedded space", "a b"],
    ["range syntax (..)", "a..b"],
    ["shell metacharacters", "foo;bar"],
  ];
  for (const [label, ref] of rejects) {
    test(`rejects ${label}`, () => {
      expect(GitRef.safeParse(ref).success).toBe(false);
    });
  }
});

describe("UpdateConnectionRequest", () => {
  test("accepts a clean repoUrl + branch", () => {
    const r = UpdateConnectionRequest.safeParse({
      repoUrl: "git@github.com:org/repo.git",
      branch: "release/1.2",
    });
    expect(r.success).toBe(true);
  });

  // The RCE: a loose update body would persist a malicious repoUrl that the
  // runner later clones. repoUrl must flow through GitRepoUrl on update too.
  test("rejects a malicious ext:: repoUrl on update", () => {
    const r = UpdateConnectionRequest.safeParse({
      repoUrl: "ext::sh -c id",
    });
    expect(r.success).toBe(false);
  });

  test("rejects a malicious branch ref on update", () => {
    const r = UpdateConnectionRequest.safeParse({
      branch: "-x",
    });
    expect(r.success).toBe(false);
  });

  test("accepts an empty body (all fields optional)", () => {
    expect(UpdateConnectionRequest.safeParse({}).success).toBe(true);
  });
});

describe("DeployRequest.gitRef", () => {
  test("accepts a valid gitRef", () => {
    const r = DeployRequest.safeParse({
      platform: "ANDROID",
      target: "FIREBASE_APP_DISTRIBUTION",
      gitRef: "v1.0.0",
    });
    expect(r.success).toBe(true);
  });

  test("rejects an option-injection gitRef", () => {
    const r = DeployRequest.safeParse({
      platform: "ANDROID",
      target: "FIREBASE_APP_DISTRIBUTION",
      gitRef: "-x",
    });
    expect(r.success).toBe(false);
  });
});

describe("UpdateBuildConfigRequest.gitRef", () => {
  test("accepts a valid gitRef", () => {
    const r = UpdateBuildConfigRequest.safeParse({ gitRef: "release/1.2" });
    expect(r.success).toBe(true);
  });

  test("rejects a range-syntax gitRef", () => {
    const r = UpdateBuildConfigRequest.safeParse({ gitRef: "a..b" });
    expect(r.success).toBe(false);
  });
});
