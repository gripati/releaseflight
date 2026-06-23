/**
 * Framework auto-detection — fully no-code.
 *
 * Detects the mobile framework AND auto-locates the project inside a monorepo,
 * so the user never points at a subfolder. It collects every project-looking
 * directory (the root + subfolders, depth ≤ MAX_DEPTH) and ranks them so the
 * REAL app wins over strays:
 *   - platform-incompatible projects are excluded (an iOS-only project is never
 *     returned for an Android build — we throw an actionable error instead);
 *   - example/sample/demo/e2e folders are heavily penalised;
 *   - real JS/Flutter apps (Expo/RN/Flutter) outrank a bare stray *.xcodeproj
 *     or hoisted-dependency root;
 *   - then preferred names (mobile/native/client…), then shallowest, then a
 *     deterministic alphabetical tiebreak so the same repo always resolves the
 *     same way on every machine.
 *
 * Per-directory priority:
 *   1. Flutter        — pubspec.yaml with a `flutter:` section
 *   2. Expo           — package.json deps has `expo` (+ app config OR native dir)
 *   3. React Native   — package.json deps has `react-native` (+ a native dir)
 *   4. iOS native     — *.xcworkspace / *.xcodeproj
 *   5. Android native — settings.gradle[.kts] / gradlew
 *
 * Every filesystem read is guarded: one unreadable file or directory anywhere
 * in the tree can never abort detection of an otherwise-valid sibling project.
 */
import fs from "node:fs";
import path from "node:path";

export type Framework = "REACT_NATIVE" | "EXPO" | "FLUTTER" | "IOS_NATIVE" | "ANDROID_NATIVE";
export type DetectPlatform = "IOS" | "ANDROID";

export interface DetectionResult {
  framework: Framework;
  /** Directory that contains the native ios/ and android/ folders. May be a
   *  monorepo subfolder of the source root (auto-located). */
  projectRoot: string;
  /** Relative path from the search root to projectRoot ("" when at the root). */
  subpath: string;
  /** Expo: true when no committed ios/android dirs at all (needs prebuild). */
  expoManaged?: boolean;
}

/** Dirs that are never a mobile project root — skipped during the scan. */
const SKIP_DIRS = new Set([
  "node_modules",
  "Pods",
  "build",
  "dist",
  "out",
  ".git",
  ".expo",
  ".next",
  ".turbo",
  ".idea",
  ".vscode",
  "DerivedData",
  "vendor",
  "Carthage",
  ".gradle",
  "fastlane",
  "coverage",
  "tmp",
  // These are PARTS of a project, not separate project roots:
  "ios",
  "android",
]);

/** Folder basenames that are most likely the mobile app (tie-break bonus). */
const PREFERRED_NAMES = ["mobile", "native", "client", "rn", "expo", "frontend", "app-mobile"];

/** Path segments that mark a non-shippable sample/test app — heavily penalised. */
const EXAMPLE_RE = /^(examples?|samples?|demos?|e2e|fixtures?|templates?|tests?|__tests__|playground|scratch)$/i;

const MAX_DEPTH = 3;
const MAX_DIRS_SCANNED = 1500;

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJson(p: string): Record<string, unknown> | null {
  const text = readText(p);
  if (text == null) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function dirHasExt(dir: string, ext: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(ext));
  } catch {
    return false;
  }
}

/** Detects the framework in a SINGLE directory, or null if none lives here.
 *  Never throws — every read is guarded. */
function detectAt(dir: string): Omit<DetectionResult, "subpath"> | null {
  try {
    const hasIos = exists(path.join(dir, "ios"));
    const hasAndroid = exists(path.join(dir, "android"));

    // 1. Flutter
    const pubspec = readText(path.join(dir, "pubspec.yaml"));
    if (pubspec && (/^\s*flutter\s*:/m.test(pubspec) || /sdk:\s*flutter/.test(pubspec))) {
      return { framework: "FLUTTER", projectRoot: dir };
    }

    // 2 & 3. JS-based (Expo / React Native). Require a real app signal — a bare
    // package.json with a hoisted react-native dep (common at monorepo roots)
    // is NOT a buildable app, so we demand an app config or a native dir.
    const pkg = readJson(path.join(dir, "package.json"));
    if (pkg) {
      const deps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
      };
      const hasExpoConfig =
        exists(path.join(dir, "app.json")) ||
        exists(path.join(dir, "app.config.js")) ||
        exists(path.join(dir, "app.config.ts")) ||
        exists(path.join(dir, "app.config.cjs"));
      if ("expo" in deps && (hasExpoConfig || hasIos || hasAndroid)) {
        return { framework: "EXPO", projectRoot: dir, expoManaged: !hasIos && !hasAndroid };
      }
      if ("react-native" in deps && (hasIos || hasAndroid)) {
        return { framework: "REACT_NATIVE", projectRoot: dir };
      }
    }

    // 4. iOS native
    if (dirHasExt(dir, ".xcworkspace") || dirHasExt(dir, ".xcodeproj")) {
      return { framework: "IOS_NATIVE", projectRoot: dir };
    }

    // 5. Android native
    if (
      exists(path.join(dir, "settings.gradle")) ||
      exists(path.join(dir, "settings.gradle.kts")) ||
      exists(path.join(dir, "gradlew"))
    ) {
      return { framework: "ANDROID_NATIVE", projectRoot: dir };
    }
  } catch {
    /* unreadable dir — treat as no match, never abort the scan */
  }
  return null;
}

interface Candidate {
  result: Omit<DetectionResult, "subpath">;
  subpath: string;
  depth: number;
}

/**
 * Detects the framework, auto-locating the project within `root`. `platform`,
 * when given, restricts the result to a project that can actually build it.
 */
export function detectFramework(root: string, platform?: DetectPlatform): DetectionResult {
  const candidates = collectCandidates(root);
  if (candidates.length === 0) {
    const peek = listDirs(root).slice(0, 12).join(", ");
    throw new Error(
      `Could not detect a supported mobile framework (Flutter / React Native / Expo / iOS native / ` +
        `Android native) in ${root} or its subfolders${peek ? ` (looked through: ${peek})` : ""}. ` +
        `Point the build source at your app folder or its monorepo root.`,
    );
  }

  let pool = candidates;
  if (platform) {
    const compatible = candidates.filter((c) => platformOk(c.result.framework, platform));
    if (compatible.length === 0) {
      const names = candidates
        .map((c) => `${c.subpath || "."} (${c.result.framework})`)
        .join(", ");
      throw new Error(
        `Found a project (${names}) but none can build ${platform}. ` +
          `Connect/point at a project that targets ${platform}.`,
      );
    }
    pool = compatible;
  }

  pool.sort((a, b) => rank(a, platform) - rank(b, platform) || a.subpath.localeCompare(b.subpath));
  const best = pool[0]!;
  return { ...best.result, subpath: best.subpath };
}

/** BFS for project folders (root + depth ≤ MAX_DEPTH). Children are sorted so
 *  the scan is deterministic and likely-app folders are visited first; a found
 *  project is a leaf (we don't descend into it). */
function collectCandidates(root: string): Candidate[] {
  const found: Candidate[] = [];
  const queue: { dir: string; depth: number; subpath: string }[] = [
    { dir: root, depth: 0, subpath: "" },
  ];
  let scanned = 0;

  while (queue.length > 0 && scanned < MAX_DIRS_SCANNED) {
    const { dir, depth, subpath } = queue.shift()!;
    scanned++;
    const r = detectAt(dir);
    if (r) {
      found.push({ result: r, subpath, depth });
      // A matched SUBFOLDER is a leaf — don't descend into a real app's guts.
      // But always keep scanning below the search ROOT: a monorepo root can
      // itself match (a stray *.xcodeproj / hoisted dep) yet still contain the
      // real app in a subfolder.
      if (depth >= 1) continue;
    }
    if (depth >= MAX_DEPTH) continue;
    for (const name of orderedChildDirs(dir)) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      queue.push({
        dir: path.join(dir, name),
        depth: depth + 1,
        subpath: subpath ? `${subpath}/${name}` : name,
      });
    }
  }
  return found;
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Children sorted deterministically: preferred app-folder names first, then
 *  alphabetical — so the dir budget favours likely projects and results don't
 *  depend on filesystem readdir order. */
function orderedChildDirs(dir: string): string[] {
  return listDirs(dir).sort((a, b) => {
    const ap = PREFERRED_NAMES.indexOf(a.toLowerCase());
    const bp = PREFERRED_NAMES.indexOf(b.toLowerCase());
    const ar = ap >= 0 ? ap : PREFERRED_NAMES.length;
    const br = bp >= 0 ? bp : PREFERRED_NAMES.length;
    return ar - br || a.localeCompare(b);
  });
}

/** Lower is better. Compatibility ≫ not-an-example ≫ real-app-framework ≫
 *  preferred-name ≫ shallow. Depth is intentionally the weakest signal so a
 *  real app two levels down beats a shallow stray .xcodeproj. */
function rank(c: Candidate, platform?: DetectPlatform): number {
  let score = 0;
  if (platform && !platformOk(c.result.framework, platform)) score += 1_000_000;
  if (c.subpath.split("/").some((seg) => EXAMPLE_RE.test(seg))) score += 100_000;
  // Bare native (a stray *.xcodeproj or gradle wrapper) is a weaker signal than
  // a real JS/Flutter app with a manifest.
  score += c.result.framework === "IOS_NATIVE" || c.result.framework === "ANDROID_NATIVE" ? 1000 : 0;
  const base = c.subpath.split("/").pop() ?? "";
  const pref = PREFERRED_NAMES.indexOf(base.toLowerCase());
  score += pref >= 0 ? pref : 100;
  score += c.depth * 10;
  return score;
}

function platformOk(fw: Framework, platform: DetectPlatform): boolean {
  return platform === "IOS" ? supportsIos(fw) : supportsAndroid(fw);
}

/** Whether a detected framework can produce an Android artifact. */
export function supportsAndroid(fw: Framework): boolean {
  return fw === "FLUTTER" || fw === "REACT_NATIVE" || fw === "EXPO" || fw === "ANDROID_NATIVE";
}

/** Whether a detected framework can produce an iOS artifact. */
export function supportsIos(fw: Framework): boolean {
  return fw === "FLUTTER" || fw === "REACT_NATIVE" || fw === "EXPO" || fw === "IOS_NATIVE";
}
