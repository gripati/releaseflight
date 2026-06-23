/**
 * Build versioning — reads the project's current version + build number so the
 * pipeline can auto-increment the build number for every build.
 *
 * The marketing VERSION (1.0.0) is owned by the developer in the project; we
 * only read it (for display + as the floor). The BUILD NUMBER is what the
 * pipeline auto-increments and stamps into the artifact (iOS CFBundleVersion,
 * Android versionCode) so every build is uniquely, monotonically numbered.
 */
import fs from "node:fs";
import path from "node:path";
import type { Framework } from "../detect/detectFramework";

export interface ProjectVersion {
  /** Marketing version, e.g. "1.0.0". Null when it couldn't be read. */
  marketingVersion: string | null;
  /** Current numeric build number in the project (CFBundleVersion / versionCode). */
  buildNumber: number | null;
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJson(p: string): Record<string, unknown> | null {
  const t = readText(p);
  if (t == null) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Reads the project's current marketing version + build number, framework- and
 *  platform-aware. Best-effort: any field it can't read comes back null. */
export function readProjectVersion(
  projectRoot: string,
  framework: Framework,
  platform: "IOS" | "ANDROID",
): ProjectVersion {
  try {
    if (framework === "FLUTTER") return fromFlutter(projectRoot);
    if (framework === "EXPO") {
      const e = fromExpoConfig(projectRoot, platform);
      if (e.marketingVersion != null || e.buildNumber != null) return e;
    }
    return platform === "IOS" ? fromIos(projectRoot) : fromAndroid(projectRoot);
  } catch {
    return { marketingVersion: null, buildNumber: null };
  }
}

function fromFlutter(root: string): ProjectVersion {
  const y = readText(path.join(root, "pubspec.yaml"));
  const m = y ? /^\s*version:\s*([^\s#]+)/m.exec(y) : null;
  if (!m?.[1]) return { marketingVersion: null, buildNumber: null };
  const [mv, bn] = m[1].split("+");
  const n = bn ? parseInt(bn, 10) : NaN;
  return { marketingVersion: mv || null, buildNumber: Number.isFinite(n) ? n : null };
}

function fromExpoConfig(root: string, platform: "IOS" | "ANDROID"): ProjectVersion {
  const a = readJson(path.join(root, "app.json"));
  const expo = ((a?.expo as Record<string, unknown> | undefined) ?? a ?? {}) as Record<string, unknown>;
  const marketingVersion = typeof expo.version === "string" ? expo.version : null;
  let buildNumber: number | null = null;
  if (platform === "IOS") {
    const ios = expo.ios as { buildNumber?: unknown } | undefined;
    const raw = ios?.buildNumber;
    const n = raw != null ? parseInt(String(raw), 10) : NaN;
    buildNumber = Number.isFinite(n) ? n : null;
  } else {
    const android = expo.android as { versionCode?: unknown } | undefined;
    const raw = android?.versionCode;
    const n = raw != null ? parseInt(String(raw), 10) : NaN;
    buildNumber = Number.isFinite(n) ? n : null;
  }
  return { marketingVersion, buildNumber };
}

function fromIos(root: string): ProjectVersion {
  const plist = findAppInfoPlist(path.join(root, "ios")) ?? findAppInfoPlist(root);
  if (!plist) return { marketingVersion: null, buildNumber: null };
  const content = readText(plist) ?? "";
  const mv = plistString(content, "CFBundleShortVersionString");
  const bnRaw = plistString(content, "CFBundleVersion");
  const n = bnRaw ? parseInt(bnRaw, 10) : NaN;
  return {
    marketingVersion: mv && !mv.startsWith("$(") ? mv : null,
    buildNumber: Number.isFinite(n) ? n : null,
  };
}

function fromAndroid(root: string): ProjectVersion {
  const gradle =
    readText(path.join(root, "android", "app", "build.gradle")) ??
    readText(path.join(root, "app", "build.gradle")) ??
    readText(path.join(root, "android", "app", "build.gradle.kts")) ??
    "";
  const vc = /versionCode\s*=?\s*(\d+)/.exec(gradle);
  const vn = /versionName\s*=?\s*["']([^"']+)["']/.exec(gradle);
  const n = vc?.[1] ? parseInt(vc[1], 10) : NaN;
  return { marketingVersion: vn?.[1] ?? null, buildNumber: Number.isFinite(n) ? n : null };
}

/**
 * Locates the app target's Info.plist (e.g. ios/TERRA/Info.plist), preferring
 * the folder matching the scheme, then a plist that actually carries a
 * CFBundleVersion (an app, not a test/extension target).
 */
export function findAppInfoPlist(iosDir: string, scheme?: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(iosDir);
  } catch {
    return null;
  }
  const candidates: string[] = [];
  for (const e of entries) {
    if (e === "Pods" || e.startsWith(".")) continue;
    const p = path.join(iosDir, e, "Info.plist");
    if (fs.existsSync(p)) candidates.push(p);
  }
  if (candidates.length === 0) return null;
  if (scheme) {
    const match = candidates.find(
      (p) => path.basename(path.dirname(p)).toLowerCase() === scheme.toLowerCase(),
    );
    if (match) return match;
  }
  // Prefer a real APP target's plist — never an app extension, App Clip, or
  // Watch companion (those also carry a CFBundleVersion and would be stamped
  // while the actual app keeps its old number).
  const appPlist = candidates.find((p) => {
    const c = readText(p) ?? "";
    if (/<key>NSExtension<\/key>/.test(c)) return false;
    if (/<key>WKCompanionAppBundleIdentifier<\/key>/.test(c)) return false;
    const pkg = plistString(c, "CFBundlePackageType");
    if (pkg && pkg !== "APPL") return false;
    return plistString(c, "CFBundleVersion") != null;
  });
  if (appPlist) return appPlist;
  const withVersion = candidates.find((p) => plistString(readText(p) ?? "", "CFBundleVersion") != null);
  return withVersion ?? candidates[0]!;
}

function plistString(content: string, key: string): string | null {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  return re.exec(content)?.[1] ?? null;
}

/** A marketing version safe to inject as --build-name / android.injected
 *  .version.name — digits with up to two dots. Rejects unresolved $(VAR) or
 *  junk so we never stamp a broken versionName. */
export function cleanMarketingVersion(v: string | null | undefined): string | null {
  return v && /^[0-9]+(\.[0-9]+){0,2}$/.test(v) ? v : null;
}

/**
 * Reads the PROJECT's real iOS bundle identifier (Expo app.json
 * ios.bundleIdentifier, else PRODUCT_BUNDLE_IDENTIFIER from the .xcodeproj,
 * most-frequent main-app value — ignoring watch/extension/test sub-ids and
 * $(VAR) values). Used to verify App Store Connect access against the bundle
 * that will actually be SIGNED, not a possibly-stale DB value.
 */
export function readProjectBundleId(projectRoot: string, framework: Framework): string | null {
  try {
    if (framework === "EXPO") {
      const a = readJson(path.join(projectRoot, "app.json"));
      const expo = ((a?.expo as Record<string, unknown> | undefined) ?? a ?? {}) as Record<string, unknown>;
      const ios = expo.ios as { bundleIdentifier?: unknown } | undefined;
      if (typeof ios?.bundleIdentifier === "string" && ios.bundleIdentifier) {
        return ios.bundleIdentifier;
      }
    }
    const iosDir = framework === "IOS_NATIVE" ? projectRoot : path.join(projectRoot, "ios");
    let entries: string[];
    try {
      entries = fs.readdirSync(iosDir);
    } catch {
      return null;
    }
    const proj = entries.find((e) => e.endsWith(".xcodeproj"));
    if (!proj) return null;
    const pbx = readText(path.join(iosDir, proj, "project.pbxproj"));
    if (!pbx) return null;
    const counts = new Map<string, number>();
    const re = /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([A-Za-z0-9.\-]+)"?\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pbx)) !== null) {
      const id = m[1]!;
      if (id.includes("$(")) continue;
      if (/\.(watchkitapp|watchkitextension|watchkit|UITests|Tests|ShareExtension|NotificationService|clip)\b/i.test(id))
        continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [id, n] of counts) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    return best;
  } catch {
    return null;
  }
}
