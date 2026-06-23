/**
 * iOS build executor — produces a signed IPA from Flutter / React Native /
 * Expo-bare / native-iOS projects. macOS + Xcode only.
 *
 * Mirrors the proven Unity GamePublisher flow:
 *   pod install (if Podfile) → xcodebuild archive → xcodebuild -exportArchive.
 *
 * Signing: automatic. If an App Store Connect API key (.p8) is connected it is
 * passed via -authenticationKey* (fully headless). Otherwise the runner relies
 * on the Mac's logged-in Xcode account + DEVELOPMENT_TEAM (local dev signing).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Framework } from "../../detect/detectFramework";
import { runProcess, tryProcess, ProcessError, type RunProcessOptions } from "../runProcess";
import { findNewestBySuffix, findFirstBySuffix } from "../findArtifact";
import { findAppInfoPlist, cleanMarketingVersion } from "../versioning";
import { generateExportOptions, type ExportOptions } from "./exportOptions";

export interface AppleAuthKey {
  keyId: string;
  issuerId: string;
  p8Path: string;
}

export interface IosBuildResult {
  artifactPath: string;
  artifactKind: "IPA";
}

interface IosBuildCtx {
  projectRoot: string;
  framework: Framework;
  method: ExportOptions["method"];
  scheme?: string | null;
  configuration: string;
  teamId?: string | null;
  apple?: AppleAuthKey | null;
  /** Auto-incremented build number to stamp as CFBundleVersion. */
  buildNumber?: string | null;
  /** Marketing version (Flutter --build-name); iOS keeps the project's own. */
  marketingVersion?: string | null;
  env: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

function authFlags(apple?: AppleAuthKey | null): string[] {
  if (!apple) return [];
  return [
    "-authenticationKeyPath",
    apple.p8Path,
    "-authenticationKeyID",
    apple.keyId,
    "-authenticationKeyIssuerID",
    apple.issuerId,
  ];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function buildIos(ctx: IosBuildCtx): Promise<IosBuildResult> {
  const proc: RunProcessOptions = {
    env: ctx.env,
    onLine: (l) => ctx.onLine?.(l),
    signal: ctx.signal,
    timeoutMs: 45 * 60_000,
  };
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `mq-ios-${randomUUID()}-`));

  // ── Flutter ──────────────────────────────────────────────────────────
  if (ctx.framework === "FLUTTER") {
    await runProcess("flutter", ["pub", "get"], { ...proc, cwd: ctx.projectRoot });
    // `flutter build ipa` archives AND exports in one step, so the team must be
    // in ExportOptions up front — a missing teamID is THE cause of "No profiles
    // were found" at export. Resolve it from the Flutter iOS Runner project
    // (explicit → pbxproj DEVELOPMENT_TEAM → showBuildSettings).
    const fIosDir = path.join(ctx.projectRoot, "ios");
    const fWorkspace = findFirstBySuffix(fIosDir, ".xcworkspace");
    const fProject = findFirstBySuffix(fIosDir, ".xcodeproj");
    const teamId = await resolveTeamId({
      explicit: ctx.teamId,
      projectPath: fProject,
      container: fWorkspace ?? fProject,
      isWorkspace: fWorkspace != null,
      scheme: "Runner",
      configuration: ctx.configuration,
      env: ctx.env,
    });
    assertExportTeam(teamId);
    ctx.onLine?.(`Export signing team: ${teamId}`);
    const plist = path.join(work, "ExportOptions.plist");
    await fs.writeFile(plist, generateExportOptions({ method: ctx.method, teamId }));
    const flutterArgs = ["build", "ipa", "--release", `--export-options-plist=${plist}`];
    const fmv = cleanMarketingVersion(ctx.marketingVersion);
    if (ctx.buildNumber) flutterArgs.push(`--build-number=${ctx.buildNumber}`);
    if (fmv) flutterArgs.push(`--build-name=${fmv}`);
    await runProcess("flutter", flutterArgs, { ...proc, cwd: ctx.projectRoot });
    const ipa =
      findNewestBySuffix(path.join(ctx.projectRoot, "build", "ios", "ipa"), ".ipa") ??
      findNewestBySuffix(path.join(ctx.projectRoot, "build"), ".ipa");
    if (!ipa) throw new Error("Flutter build finished but no IPA was found.");
    return { artifactPath: ipa, artifactKind: "IPA" };
  }

  // ── React Native / Expo-bare / native iOS (xcodebuild) ───────────────
  const iosDir =
    ctx.framework === "IOS_NATIVE" ? ctx.projectRoot : path.join(ctx.projectRoot, "ios");
  if (!(await pathExists(iosDir))) {
    throw new Error(`No iOS project directory found at ${iosDir}.`);
  }

  if (await pathExists(path.join(iosDir, "Podfile"))) {
    ctx.onLine?.("Running pod install…");
    const ok = await tryProcess("pod", ["install"], { ...proc, cwd: iosDir });
    if (!ok) {
      await runProcess("pod", ["install", "--repo-update"], { ...proc, cwd: iosDir });
    }
  }

  const workspace = findFirstBySuffix(iosDir, ".xcworkspace");
  const project = findFirstBySuffix(iosDir, ".xcodeproj");
  const container = workspace ?? project;
  if (!container) {
    throw new Error(`No .xcworkspace or .xcodeproj found in ${iosDir}.`);
  }
  const isWorkspace = workspace != null;

  const scheme = ctx.scheme || (await detectScheme(container, isWorkspace, ctx.env));
  if (!scheme) {
    throw new Error(
      "Could not auto-detect an Xcode scheme. Make sure your Xcode project has a shared scheme " +
        "(Xcode → Product → Scheme → Manage Schemes → tick “Shared”) named after the app.",
    );
  }
  ctx.onLine?.(`Using ${isWorkspace ? "workspace" : "project"} ${path.basename(container)}, scheme ${scheme}`);

  // Best-effort team BEFORE archiving — used only as the archive's
  // DEVELOPMENT_TEAM override (the project's own setting applies otherwise).
  // The authoritative team for export is read from the archive afterwards.
  // explicit → pbxproj DEVELOPMENT_TEAM (instant) → showBuildSettings (slow).
  const preTeamId = await resolveTeamId({
    explicit: ctx.teamId,
    projectPath: project,
    container,
    isWorkspace,
    scheme,
    configuration: ctx.configuration,
    env: ctx.env,
  });
  if (preTeamId) ctx.onLine?.(`Signing team: ${preTeamId}`);

  // Stamp the auto-incremented build number as CFBundleVersion. RN/Expo
  // Info.plists usually carry a LITERAL CFBundleVersion (not $(…)), so the
  // xcodebuild build-setting alone wouldn't take — we edit the app Info.plist
  // and restore it after archiving so the user's working copy is untouched.
  // Back up as a raw Buffer (byte-exact for binary plists) BEFORE any mutation;
  // the actual Set happens inside the try whose finally restores it.
  const stampVersion = cleanMarketingVersion(ctx.marketingVersion);
  let restorePlist: (() => Promise<void>) | null = null;
  let plistToStamp: string | null = null;
  if (ctx.buildNumber || stampVersion) {
    const plist = findAppInfoPlist(iosDir, scheme);
    if (plist) {
      const original = await fs.readFile(plist);
      restorePlist = async () => {
        await fs.writeFile(plist, original).catch(() => undefined);
      };
      plistToStamp = plist;
    }
  }

  // Archive
  const archivePath = path.join(work, "app.xcarchive");
  const archiveArgs = [
    isWorkspace ? "-workspace" : "-project",
    container,
    "-scheme",
    scheme,
    "-configuration",
    ctx.configuration,
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archivePath,
    "archive",
    "-allowProvisioningUpdates",
    "ENABLE_USER_SCRIPT_SANDBOXING=NO",
  ];
  if (preTeamId) {
    archiveArgs.push(`DEVELOPMENT_TEAM=${preTeamId}`, "CODE_SIGN_STYLE=Automatic");
  }
  // Belt-and-suspenders for projects whose Info.plist uses the $(…) variables.
  if (ctx.buildNumber) archiveArgs.push(`CURRENT_PROJECT_VERSION=${ctx.buildNumber}`);
  if (stampVersion) archiveArgs.push(`MARKETING_VERSION=${stampVersion}`);
  archiveArgs.push(...authFlags(ctx.apple));
  try {
    // Mutate the plist INSIDE the try so the finally always restores it,
    // regardless of where a failure occurs.
    if (plistToStamp) {
      if (ctx.buildNumber) await setPlistKey(plistToStamp, "CFBundleVersion", ctx.buildNumber, proc);
      if (stampVersion) {
        await setPlistKey(plistToStamp, "CFBundleShortVersionString", stampVersion, proc);
      }
      ctx.onLine?.(
        `Stamped ${stampVersion ? `v${stampVersion} ` : ""}${ctx.buildNumber ? `build ${ctx.buildNumber}` : ""} into ${path.basename(path.dirname(plistToStamp))}/Info.plist`,
      );
    }
    await runProcess("xcodebuild", archiveArgs, { ...proc, cwd: iosDir });
  } finally {
    if (restorePlist) await restorePlist();
  }

  // The archive embeds the exact team that signed it — the authoritative,
  // always-present source for ExportOptions.plist. Reading it from the archive
  // is far more reliable than a second `xcodebuild -showBuildSettings`, which
  // can be slow or fail on large CocoaPods workspaces and silently yield no
  // team. A MISSING teamID in ExportOptions is THE cause of "Automatic signing
  // cannot update bundle identifier" / "No profiles were found" at export.
  const teamId = (await readArchiveTeam(archivePath)) ?? preTeamId;
  assertExportTeam(teamId);
  ctx.onLine?.(`Export signing team: ${teamId}`);

  // Export
  const plist = path.join(work, "ExportOptions.plist");
  await fs.writeFile(plist, generateExportOptions({ method: ctx.method, teamId }));
  const exportDir = path.join(work, "export");
  const exportBase = [
    "-exportArchive",
    "-archivePath",
    archivePath,
    "-exportOptionsPlist",
    plist,
    "-exportPath",
    exportDir,
    "-allowProvisioningUpdates",
  ];
  await runExport({
    method: ctx.method,
    exportBase,
    apple: ctx.apple,
    teamId,
    proc: { ...proc, cwd: iosDir },
    log: ctx.onLine,
  });

  const ipa = findNewestBySuffix(exportDir, ".ipa");
  if (!ipa) throw new Error("Export finished but no IPA was produced.");
  return { artifactPath: ipa, artifactKind: "IPA" };
}

async function detectScheme(
  container: string,
  isWorkspace: boolean,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const target = isWorkspace ? ["-workspace", container] : ["-project", container];
  const res = await tryProcess("xcodebuild", [...target, "-list", "-json"], { env });
  if (!res) return null;
  try {
    const parsed = JSON.parse(res.stdout) as {
      workspace?: { schemes?: string[] };
      project?: { schemes?: string[] };
    };
    const schemes = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
    // The app scheme almost always matches the workspace/project name
    // (e.g. TERRA.xcworkspace → "TERRA"). RN/Expo workspaces list 100+ Pods
    // library schemes, so an alphabetical "first non-pods" pick is wrong.
    const base = path
      .basename(container)
      .replace(/\.(xcworkspace|xcodeproj)$/i, "")
      .toLowerCase();
    const exact = schemes.find((s) => s.toLowerCase() === base);
    if (exact) return exact;
    return schemes.find((s) => !/^Pods-|test|_privacy/i.test(s)) ?? schemes[0] ?? null;
  } catch {
    return null;
  }
}

/** Reads the project's DEVELOPMENT_TEAM so the export's ExportOptions.plist
 *  carries a teamID (otherwise automatic signing can't find a profile).
 *  Best-effort only: `-showBuildSettings` on a large CocoaPods workspace can be
 *  slow or exit non-zero, so it is bounded by a timeout and the authoritative
 *  team is read from the archive after it builds (see readArchiveTeam). */
async function detectTeamId(
  container: string,
  isWorkspace: boolean,
  scheme: string,
  configuration: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const target = isWorkspace ? ["-workspace", container] : ["-project", container];
  const res = await tryProcess(
    "xcodebuild",
    [...target, "-scheme", scheme, "-configuration", configuration, "-showBuildSettings"],
    { env, timeoutMs: 120_000 },
  );
  if (!res) return null;
  const m = /DEVELOPMENT_TEAM\s*=\s*([A-Z0-9]{10})/.exec(res.stdout);
  return m?.[1] ?? null;
}

/**
 * Reads the exact signing team from a freshly-built .xcarchive. The archive's
 * Info.plist records `ApplicationProperties.Team` — the team that actually
 * signed it, and for any org-team signing it is present and exactly what
 * xcodebuild used, so ExportOptions can never disagree with the archive. Falls
 * back to `codesign` on the embedded .app. May still be null for free/personal
 * teams or manually-signed archives; the caller guards that with
 * assertExportTeam + the pre-archive resolveTeamId result.
 */
async function readArchiveTeam(archivePath: string): Promise<string | null> {
  const res = await tryProcess("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :ApplicationProperties:Team",
    path.join(archivePath, "Info.plist"),
  ]);
  const team = res?.stdout.trim();
  if (team && /^[A-Z0-9]{10}$/.test(team)) return team;

  const app = await firstAppInArchive(archivePath);
  if (app) {
    const cs = await tryProcess("codesign", ["-dvvv", app]);
    const m = /TeamIdentifier=([A-Z0-9]{10})/.exec(`${cs?.stdout ?? ""}\n${cs?.stderr ?? ""}`);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Sets (or adds) a string key in an Info.plist via PlistBuddy. */
async function setPlistKey(
  plist: string,
  key: string,
  value: string,
  proc: RunProcessOptions,
): Promise<void> {
  const set = await tryProcess(
    "/usr/libexec/PlistBuddy",
    ["-c", `Set :${key} ${value}`, plist],
    proc,
  );
  if (!set) {
    await tryProcess("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist], proc);
  }
}

/** The packaged .app inside a built archive (Products/Applications/<App>.app). */
async function firstAppInArchive(archivePath: string): Promise<string | null> {
  const appsDir = path.join(archivePath, "Products", "Applications");
  try {
    const entries = await fs.readdir(appsDir);
    const app = entries.find((e) => e.endsWith(".app"));
    return app ? path.join(appsDir, app) : null;
  } catch {
    return null;
  }
}

interface ResolveTeamOpts {
  explicit?: string | null;
  /** The .xcodeproj directory (its project.pbxproj is grepped for the team). */
  projectPath?: string | null;
  /** The .xcworkspace or .xcodeproj to query via showBuildSettings. */
  container?: string | null;
  isWorkspace: boolean;
  scheme: string;
  configuration: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Resolves the signing team for an iOS export, cheapest-and-most-reliable
 * first: an explicit team from the build config, then DEVELOPMENT_TEAM straight
 * out of project.pbxproj (instant, no xcodebuild), then `-showBuildSettings`.
 * A null result means no team could be found — the caller fails fast rather
 * than running an export that will die with a cryptic "no profiles" error.
 */
async function resolveTeamId(opts: ResolveTeamOpts): Promise<string | null> {
  if (opts.explicit) return opts.explicit;
  if (opts.projectPath) {
    const fromPbx = await readTeamFromPbxproj(opts.projectPath);
    if (fromPbx) return fromPbx;
  }
  if (opts.container) {
    return detectTeamId(opts.container, opts.isWorkspace, opts.scheme, opts.configuration, opts.env);
  }
  return null;
}

/** Reads DEVELOPMENT_TEAM directly from an .xcodeproj/project.pbxproj. Picks the
 *  most frequent team id (the app target dominates over extensions/watch). */
async function readTeamFromPbxproj(xcodeprojDir: string): Promise<string | null> {
  try {
    const pbx = await fs.readFile(path.join(xcodeprojDir, "project.pbxproj"), "utf8");
    const counts = new Map<string, number>();
    const re = /DEVELOPMENT_TEAM\s*=\s*([A-Z0-9]{10})\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pbx)) !== null) {
      const team = m[1]!;
      counts.set(team, (counts.get(team) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [team, n] of counts) {
      if (n > bestN) {
        best = team;
        bestN = n;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** Guards the export: automatic signing without a team always fails at
 *  -exportArchive with "No profiles were found". Fail fast with an actionable
 *  message instead. */
function assertExportTeam(teamId: string | null): asserts teamId is string {
  if (!teamId) {
    throw new Error(
      "Could not determine an Apple Team ID for signing. Set the Team ID in the app's build " +
        "config, connect an Apple credential for the signing team, or sign in to Xcode with " +
        "that team on the build machine.",
    );
  }
}

interface RunExportOpts {
  method: ExportOptions["method"];
  exportBase: string[];
  apple?: AppleAuthKey | null;
  teamId: string;
  proc: RunProcessOptions;
  log?: (line: string) => void;
}

/**
 * Runs `xcodebuild -exportArchive`, choosing the signing route by method.
 *
 * release-testing (Firebase) signs best with the Mac's local distribution
 * identity + `-allowProvisioningUpdates` — the proven, key-free recipe — so the
 * Xcode account is tried first and a connected App Store Connect key is only a
 * fallback. app-store-connect prefers the key (it can provision headlessly),
 * falling back to the account. On a full failure an actionable signing
 * diagnostic is emitted and every attempt's real error is surfaced.
 */
async function runExport(opts: RunExportOpts): Promise<void> {
  const key = opts.apple ? authFlags(opts.apple) : null;
  const account = { label: "the Mac's Xcode account", flags: [] as string[] };
  const ascKey = key ? { label: "the App Store Connect key", flags: key } : null;

  // app-store-connect: try the ASC key, then RETRY it — `-allowProvisioningUpdates`
  // often creates the App Store profile on the first pass but only USES it on the
  // second, so a wrong-first-time "No profiles were found" clears on retry. The
  // Mac account is a last resort. release-testing (Firebase): the local identity
  // via the Mac account is the proven path, ASC key only as fallback.
  const attempts =
    opts.method === "app-store-connect"
      ? [ascKey, ascKey, account].filter(Boolean)
      : [account, ascKey].filter(Boolean);

  const errors: string[] = [];
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]!;
    opts.log?.(
      i === 0
        ? `Exporting IPA (signing via ${a.label})…`
        : `Export retry — signing via ${a.label}…`,
    );
    try {
      await runProcess("xcodebuild", [...opts.exportBase, ...a.flags], opts.proc);
      return;
    } catch (err) {
      const tail = err instanceof ProcessError ? err.tail : String(err);
      errors.push(`— via ${a.label}:\n${tail}`);
    }
  }

  await emitSigningDiagnostic(opts.teamId, opts.log);
  throw new Error(
    `Export could not produce a signed IPA (tried ${attempts.length} signing route` +
      `${attempts.length === 1 ? "" : "s"}).\n\n${errors.join("\n\n")}`,
  );
}

/** After every export route fails, tells the operator WHICH wall they hit:
 *  a missing certificate vs. an account that can't provision the team. */
async function emitSigningDiagnostic(teamId: string, log?: (line: string) => void): Promise<void> {
  if (!log) return;
  const res = await tryProcess("security", ["find-identity", "-v", "-p", "codesigning"]);
  const identities = res?.stdout ?? "";
  if (identities.includes(teamId)) {
    log(
      `A signing certificate for team ${teamId} exists on this Mac, but a distribution ` +
        `provisioning profile could not be created automatically. The signed-in Xcode account / ` +
        `App Store Connect key likely lacks permission to provision team ${teamId} (wrong ` +
        `account or role), or ad-hoc distribution needs a registered device. Connect an App ` +
        `Store Connect API key for team ${teamId}, or sign in to Xcode with an account that ` +
        `manages that team.`,
    );
  } else {
    log(
      `No code-signing certificate for team ${teamId} was found on this Mac. Install the Apple ` +
        `Distribution certificate for team ${teamId} (or sign in to Xcode with that team), or ` +
        `connect an App Store Connect API key for it.`,
    );
  }
}
