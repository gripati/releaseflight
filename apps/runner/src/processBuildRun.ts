/**
 * build.run processor — clone → detect → build → sign → upload → deploy.
 *
 * Runs on the macOS runner inside a tenant context so RLS scopes every
 * Prisma query. Each phase updates `Build.status` and streams progress/logs
 * through `publishProgress` (→ Redis pub/sub → web SSE). Cancellation is
 * cooperative: a poller flips an AbortController which kills child processes.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma, prismaUnscoped, recordAudit, tenantStorage } from "@marquee/db";
import { publishProgress, JobCancelledError, type BuildRunJobData } from "@marquee/jobs";
import { storage, tenantStorageKey } from "@marquee/storage";
import { detectFramework, type Framework } from "./detect/detectFramework";
import { readProjectVersion, readProjectBundleId } from "./build/versioning";
import {
  loadGitConnection,
  loadFirebaseConnection,
  loadKeystoreConnection,
  loadAppleCredential,
  loadGoogleCredential,
} from "./credentials/loadBuildCredentials";
import { gitClone } from "./build/git";
import { runProcess } from "./build/runProcess";
import { buildAndroid } from "./build/android";
import { buildIos } from "./build/ios/buildIos";
import { deployToFirebase } from "./deploy/firebaseDeploy";
import { uploadToAppStore } from "./deploy/appleStore";
import { uploadToGooglePlay } from "./deploy/googlePlay";
import {
  AppleApps,
  AppleBuilds,
  AppleAuth,
  AppleClient,
  CredentialInvalidError,
  type TrackName,
  type ReleaseStatus,
} from "@marquee/core";

export interface ProcessBuildRunContext {
  runnerId: string;
}

/**
 * Resolve and allowlist a user-supplied local build path. Requires an absolute
 * path, resolves symlinks (so a symlink can't escape), and — when
 * `BUILDS_LOCAL_ROOT` is configured (the recommended setting for any shared
 * runner) — asserts the resolved path is inside that root. Without the env set,
 * local-folder builds keep working for single-operator runners but the path is
 * still realpath-validated to exist.
 */
export async function resolveLocalProjectPath(localPath: string): Promise<string> {
  if (!path.isAbsolute(localPath)) {
    throw new Error("Local project path must be absolute.");
  }
  let real: string;
  try {
    real = await fs.realpath(localPath);
  } catch {
    throw new Error(`Local project folder not found: ${localPath}`);
  }
  const root = process.env.BUILDS_LOCAL_ROOT;
  if (root) {
    const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
    const rel = path.relative(realRoot, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Local project path is outside the allowed builds root (BUILDS_LOCAL_ROOT).");
    }
  }
  return real;
}

type BuildStatus =
  | "QUEUED"
  | "CLONING"
  | "DETECTING"
  | "INSTALLING_DEPS"
  | "BUILDING"
  | "SIGNING"
  | "UPLOADING_ARTIFACT"
  | "DEPLOYING"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

const STEP_INDEX: Record<BuildStatus, number> = {
  QUEUED: 0,
  CLONING: 1,
  DETECTING: 2,
  INSTALLING_DEPS: 3,
  BUILDING: 4,
  SIGNING: 5,
  UPLOADING_ARTIFACT: 6,
  DEPLOYING: 7,
  DONE: 8,
  FAILED: 8,
  CANCELLED: 8,
};
const TOTAL_STEPS = 8;

const ARTIFACT_CONTENT_TYPE: Record<string, string> = {
  apk: "application/vnd.android.package-archive",
  aab: "application/octet-stream",
  ipa: "application/octet-stream",
};

export async function processBuildRun(
  input: BuildRunJobData & { jobId: string },
  ctx: ProcessBuildRunContext,
): Promise<unknown> {
  return tenantStorage.run(
    { tenantId: input.tenantId, userId: input.userId, role: "OWNER", requestId: randomUUID() },
    () => runPipeline(input, ctx),
  );
}

async function runPipeline(
  input: BuildRunJobData & { jobId: string },
  ctx: ProcessBuildRunContext,
): Promise<unknown> {
  const { jobId, buildId, appId, platform, target } = input;
  const workdir = path.join(os.tmpdir(), `mq-build-${buildId}`);
  const repoDir = path.join(workdir, "repo");
  const ac = new AbortController();
  const logBuffer: string[] = [];

  let phase: BuildStatus = "QUEUED";
  let lastFlush = 0;
  let logsKey: string | null;
  let appleP8Path: string | null = null;
  // App Store Connect app id resolved from the connected key during the iOS
  // pre-flight, reused by the post-upload processing poll.
  let resolvedStoreAppId: string | null = null;

  // Force a UTF-8 locale for all build tools. CocoaPods (Ruby) crashes with
  // "Unicode Normalization not appropriate for ASCII-8BIT" when LANG/LC_ALL
  // aren't a UTF-8 locale — common when the runner is launched non-interactively.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };

  const setPhase = async (status: BuildStatus, detail?: string): Promise<void> => {
    phase = status;
    await prisma.build.update({
      where: { id: buildId },
      data: { status },
    });
    await publishProgress({
      jobId,
      current: STEP_INDEX[status],
      total: TOTAL_STEPS,
      step: status.toLowerCase(),
      detail: detail ?? humanPhase(status),
      level: "info",
    });
  };

  const logLine = (line: string, level: "info" | "warn" | "error" = "info"): void => {
    logBuffer.push(line);
    const now = Date.now();
    if (level === "error" || now - lastFlush > 250) {
      lastFlush = now;
      void publishProgress({
        jobId,
        current: STEP_INDEX[phase],
        total: TOTAL_STEPS,
        step: phase.toLowerCase(),
        detail: line,
        level,
      }).catch(() => undefined);
    }
  };

  // Cancellation poller — flips the AbortController when the Job row is CANCELLED.
  const poller = setInterval(() => {
    void prismaUnscoped.job
      .findUnique({ where: { id: jobId }, select: { status: true } })
      .then((row) => {
        if (row?.status === "CANCELLED" && !ac.signal.aborted) {
          logLine("Cancellation requested — terminating build…", "warn");
          ac.abort();
        }
      })
      .catch(() => undefined);
  }, 3000);

  const markBuild = async (data: Record<string, unknown>): Promise<void> => {
    await prisma.build
      .update({ where: { id: buildId }, data: data as never })
      .catch(() => undefined);
  };

  try {
    await markBuild({ runnerId: ctx.runnerId, startedAt: new Date() });

    // Build config + app + saved deploy options up-front.
    const cfg = await prisma.appBuildConfig.findUnique({ where: { appId } });
    const app = await prisma.app.findUnique({ where: { id: appId } });
    const buildRow = await prisma.build.findUnique({
      where: { id: buildId },
      select: { config: true },
    });
    const deployCfg = (buildRow?.config as Record<string, unknown> | null) ?? {};

    // ── SOURCE (local folder in place, or git clone) ─────────────────────
    let sourceRoot: string;
    if (cfg?.localPath) {
      // The project already lives on this machine — build it in place, no
      // clone. Picks up uncommitted changes too. (Self-hosted runner only.)
      await setPhase("CLONING", `Using local project at ${cfg.localPath} (no clone)`);
      // Resolve + allowlist the path BEFORE using it as a build cwd. On a shared
      // runner an arbitrary absolute path lets a MAINTAINER point the build at
      // another tenant's checkout (or a dir seeded with a malicious gradlew).
      sourceRoot = await resolveLocalProjectPath(cfg.localPath);
      try {
        const rev = await runProcess("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {});
        await markBuild({ gitCommitSha: rev.stdout.trim() });
      } catch {
        /* not a git checkout — fine for a local folder */
      }
    } else {
      await setPhase("CLONING", "Cloning repository…");
      const git = await loadGitConnection(appId);
      if (!git?.repoUrl) {
        throw new Error(
          "No build source. Set a local folder or connect a Git repository in the Deploy tab.",
        );
      }
      const ref = input.gitRef ?? git.branch ?? "main";
      await fs.mkdir(workdir, { recursive: true });
      const { commitSha } = await gitClone({
        repoUrl: git.repoUrl,
        ref,
        dest: repoDir,
        privateKeyPem: git.privateKeyPem,
        onLine: (l) => logLine(l),
        signal: ac.signal,
      });
      await markBuild({ gitCommitSha: commitSha });
      logLine(`Cloned ${git.repoUrl} @ ${commitSha.slice(0, 8)}`);
      sourceRoot = repoDir;
    }

    // ── DETECTING ───────────────────────────────────────────────────────
    await setPhase("DETECTING");
    // Fully no-code: detectFramework auto-locates the project inside a monorepo
    // and only returns one that can build this platform. (workdirSubpath is no
    // longer consulted — auto-detection handles monorepo layouts.)
    const detected = detectFramework(sourceRoot, platform);
    const projectRoot = detected.projectRoot;
    const framework = cfg?.frameworkOverride ?? detected.framework;
    await markBuild({ frameworkDetected: framework });
    if (detected.subpath) logLine(`Auto-located the project in ./${detected.subpath}`);
    logLine(`Detected framework: ${framework}`);

    // Ensure this platform's native project exists. Managed/partial Expo apps
    // ship without an ios/ or android/ dir — generate it with `expo prebuild`
    // so the build "just works" (no-code). Non-Expo with a missing native dir
    // fails fast with an actionable message instead of a deep tool error.
    await ensureNativeProject(projectRoot, framework, platform, buildEnv, ac.signal, (l) =>
      logLine(l),
    );

    // ── VERSIONING ──────────────────────────────────────────────────────
    // The marketing version is owned by the project; the BUILD NUMBER is
    // auto-incremented here so every build is uniquely, monotonically numbered.
    // Floor = max(highest number we've ever assigned for this app, the project's
    // current number) so we continue from the project (e.g. CFBundleVersion 4 →
    // first build 5) and never collide. Written to the Build row up front so the
    // next build's max() already accounts for it (even if this one fails).
    const proj = readProjectVersion(projectRoot, framework, platform);
    // The web deploy route resolves the version + build number from the user's
    // launcher input (and advances the stored next), so prefer those. Fall back
    // to the project/DB floor only for re-runs / API clients that didn't supply
    // them — never reusing or decreasing a number.
    const explicitRaw =
      typeof deployCfg.buildNumber === "number"
        ? deployCfg.buildNumber
        : typeof deployCfg.buildNumber === "string" && /^\d+$/.test(deployCfg.buildNumber)
          ? Number(deployCfg.buildNumber)
          : null;
    // Ignore an out-of-range value and fall back to the computed floor.
    const explicitBuild =
      explicitRaw != null && explicitRaw >= 1 && explicitRaw <= 2_100_000_000 ? explicitRaw : null;
    const explicitVersion =
      typeof deployCfg.versionName === "string" ? deployCfg.versionName : null;
    let buildNumber: number;
    let versionString: string | null;
    if (explicitBuild != null) {
      buildNumber = explicitBuild;
      versionString = explicitVersion ?? proj.marketingVersion ?? null;
    } else {
      const autoIncrement = cfg?.autoIncrementBuildNumber ?? true;
      const floor = Math.max(await highestBuildNumber(appId), proj.buildNumber ?? 0);
      buildNumber = autoIncrement ? floor + 1 : Math.max(proj.buildNumber ?? 0, floor + 1);
      versionString = proj.marketingVersion ?? null;
      // The web route had no value to assign (first deploy on "auto") — advance
      // the stored next + version so the launcher reflects them from now on.
      // Advance nextBuildNumber only when higher (never lower it under a
      // late-landing concurrent build).
      const newNext = autoIncrement ? buildNumber + 1 : buildNumber;
      await prisma.appBuildConfig
        .updateMany({
          where: { appId, OR: [{ nextBuildNumber: null }, { nextBuildNumber: { lt: newNext } }] },
          data: { nextBuildNumber: newNext },
        })
        .catch(() => undefined);
      if (versionString != null) {
        await prisma.appBuildConfig
          .updateMany({ where: { appId }, data: { versionName: versionString } })
          .catch(() => undefined);
      }
    }
    // Persist the assigned number BEFORE building, and do NOT swallow a failure
    // here — if the row isn't stamped, the next build would recompute the same
    // number and ship a duplicate. (Cosmetic fields elsewhere use markBuild.)
    await prisma.build.update({
      where: { id: buildId },
      data: { buildNumber: String(buildNumber), versionString },
    });
    logLine(`Version ${versionString ?? "(project default)"} · build #${buildNumber.toString()}`);

    // ── BUILDING (deps + compile + sign) ───────────────────────────────
    await setPhase("BUILDING");
    let artifactPath: string;
    let artifactKind: "IPA" | "AAB" | "APK";

    if (platform === "IOS") {
      // Optional ASC API key for fully-headless signing; otherwise the Mac's
      // logged-in Xcode account + team id handle local dev signing.
      const appleCred = await loadAppleCredential(app?.credentialId);
      let apple: { keyId: string; issuerId: string; p8Path: string } | null = null;
      if (appleCred?.keyId && appleCred.issuerId && appleCred.p8) {
        appleP8Path = path.join(os.tmpdir(), `mq-asc-${buildId}.p8`);
        await fs.writeFile(appleP8Path, appleCred.p8, { mode: 0o600 });
        apple = { keyId: appleCred.keyId, issuerId: appleCred.issuerId, p8Path: appleP8Path };
      }
      const method =
        target === "FIREBASE_APP_DISTRIBUTION" ? "release-testing" : "app-store-connect";
      // App Store needs an App Store Connect key for the team that owns this app.
      // Verify up front (before the ~20-min archive) against the project's REAL
      // bundle id (not a possibly-stale DB value) so a wrong key / wrong app /
      // insufficient role fails fast with a clear message. Returns the resolved
      // App Store Connect app id for the post-upload processing poll.
      let appStoreTeamId: string | null = null;
      if (method === "app-store-connect") {
        const realBundleId = readProjectBundleId(projectRoot, framework) ?? app?.bundleId;
        const resolved = await resolveAppStoreApp(apple, realBundleId, (l) => logLine(l));
        resolvedStoreAppId = resolved.storeAppId;
        appStoreTeamId = resolved.teamId;
        if (resolvedStoreAppId && resolvedStoreAppId !== app?.storeAppId) {
          await prisma.app
            .update({ where: { id: appId }, data: { storeAppId: resolvedStoreAppId } })
            .catch(() => undefined);
        }
      }
      const out = await buildIos({
        projectRoot,
        framework,
        method,
        scheme: cfg?.iosScheme,
        configuration: cfg?.iosConfiguration ?? "Release",
        // Prefer the credential-derived team (bundle id seedId), then the app's
        // configured team; the archive read still confirms it at export.
        teamId: appStoreTeamId ?? app?.teamId,
        apple,
        buildNumber: String(buildNumber),
        marketingVersion: versionString,
        env: buildEnv,
        onLine: (l) => logLine(l),
        signal: ac.signal,
      });
      artifactPath = out.artifactPath;
      artifactKind = out.artifactKind;
    } else {
      const keystore = await loadKeystoreConnection(appId);
      const kind = target === "GOOGLE_PLAY" ? "AAB" : "APK";
      const out = await buildAndroid({
        projectRoot,
        framework,
        kind,
        androidModule: cfg?.androidModule ?? "app",
        keystore,
        buildNumber: String(buildNumber),
        marketingVersion: versionString,
        env: buildEnv,
        onLine: (l) => logLine(l),
        signal: ac.signal,
      });
      artifactPath = out.artifactPath;
      artifactKind = out.artifactKind;
    }
    logLine(`Built ${artifactKind}: ${path.basename(artifactPath)}`);
    await markBuild({ builtAt: new Date() });

    // ── UPLOADING_ARTIFACT ─────────────────────────────────────────────
    await setPhase("UPLOADING_ARTIFACT");
    const ext = artifactKind.toLowerCase();
    const stat = await fs.stat(artifactPath);
    const artifactKey = tenantStorageKey(
      input.tenantId,
      "apps",
      appId,
      "builds",
      buildId,
      `artifact.${ext}`,
    );
    await storage.putStream(artifactKey, createReadStream(artifactPath), {
      contentLength: stat.size,
      contentType: ARTIFACT_CONTENT_TYPE[ext] ?? "application/octet-stream",
    });
    const sha256 = await sha256File(artifactPath);
    await markBuild({
      artifactKind,
      artifactStorageKey: artifactKey,
      artifactSha256: sha256,
      artifactBytes: stat.size,
      uploadedAt: new Date(),
    });
    logLine(
      `Uploaded artifact (${(stat.size / 1e6).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…)`,
    );

    // ── DEPLOYING ───────────────────────────────────────────────────────
    await setPhase("DEPLOYING");
    let deployResult: Record<string, unknown> = {};
    if (target === "FIREBASE_APP_DISTRIBUTION") {
      const firebase = await loadFirebaseConnection(appId);
      if (!firebase) throw new Error("No Firebase connection. Connect one in the Deploy tab.");
      const firebaseGroups = Array.isArray(deployCfg.firebaseGroups)
        ? (deployCfg.firebaseGroups as string[])
        : undefined;
      const firebaseTesters = Array.isArray(deployCfg.firebaseTesters)
        ? (deployCfg.firebaseTesters as string[])
        : undefined;
      const res = await deployToFirebase({
        artifactPath,
        platform,
        firebase,
        releaseNotes: input.releaseNotes,
        groupAliases: firebaseGroups,
        testerEmails: firebaseTesters,
        onLine: (l) => logLine(l),
        onTick: (ms) => logLine(`Processing on Firebase… ${(ms / 1000).toFixed(0)}s`),
        signal: ac.signal,
      });
      deployResult = { provider: "firebase", ...res };
      logLine(`Distributed to Firebase App Distribution (${res.via}).`);
    } else if (target === "APPLE_TESTFLIGHT" || target === "APPLE_APP_STORE") {
      const appleCred = await loadAppleCredential(app?.credentialId);
      if (!appleCred?.keyId || !appleCred.issuerId) {
        throw new Error("Connect an App Store Connect API key (Credentials) to upload to Apple.");
      }
      if (!appleP8Path) {
        appleP8Path = path.join(os.tmpdir(), `mq-asc-${buildId}.p8`);
        await fs.writeFile(appleP8Path, appleCred.p8, { mode: 0o600 });
      }
      const appleKey = {
        keyId: appleCred.keyId,
        issuerId: appleCred.issuerId,
        p8Path: appleP8Path,
      };
      await uploadToAppStore({
        ipaPath: artifactPath,
        apple: appleKey,
        onLine: (l) => logLine(l),
        signal: ac.signal,
      });
      logLine("Uploaded to App Store Connect — waiting for Apple to finish processing…");
      // altool exit 0 only means the IPA was ACCEPTED for upload, not that
      // Apple's async processing passed. Poll the build's processingState so a
      // build that fails Apple-side (bad signature, missing keys, encryption
      // compliance) surfaces as FAILED instead of a false green.
      const storeAppId = resolvedStoreAppId ?? app?.storeAppId ?? null;
      const proc = await pollAppStoreProcessing(
        appleKey,
        storeAppId,
        versionString,
        String(buildNumber),
        ac.signal,
        (l) => logLine(l),
      );
      const consoleUrl = storeAppId
        ? `https://appstoreconnect.apple.com/apps/${storeAppId}/testflight/ios`
        : undefined;
      if (proc?.processingState === "INVALID" || proc?.processingState === "FAILED") {
        throw new Error(
          `App Store Connect rejected the build during processing (state ${proc.processingState}). ` +
            `Open App Store Connect to see Apple's reason.`,
        );
      }
      deployResult = {
        provider: "appstore",
        channel: "App Store Connect",
        uploaded: true,
        processingState: proc?.processingState ?? "PROCESSING",
        appleBuildId: proc?.id,
        storeAppId,
        consoleUrl,
      };
      logLine(
        proc?.processingState === "VALID"
          ? "Processing complete — the build is now in TestFlight and ready to submit for App Store review."
          : "Uploaded — Apple is still processing; it'll appear in TestFlight shortly.",
      );
    } else if (target === "GOOGLE_PLAY") {
      const google = await loadGoogleCredential();
      if (!google)
        throw new Error("Connect a Google Play service account (Credentials) to upload.");
      if (!app?.bundleId) throw new Error("App has no package name (bundle id).");
      const track = (
        typeof deployCfg.playTrack === "string" ? deployCfg.playTrack : "internal"
      ) as TrackName;
      const rollout =
        typeof deployCfg.playRolloutFraction === "number"
          ? deployCfg.playRolloutFraction
          : undefined;
      const status: ReleaseStatus = rollout != null && rollout < 1 ? "inProgress" : "completed";
      const res = await uploadToGooglePlay({
        aabPath: artifactPath,
        packageName: app.bundleId,
        google,
        track,
        status,
        userFraction: status === "inProgress" ? rollout : undefined,
        releaseNotes: input.releaseNotes,
        onLine: (l) => logLine(l),
      });
      deployResult = { provider: "googleplay", ...res };
      logLine(`Released version ${res.versionCode.toString()} to Google Play ${res.track}.`);
    } else {
      throw new Error(`Unknown deploy target: ${target}`);
    }

    // ── DONE ────────────────────────────────────────────────────────────
    logsKey = await persistLog(input.tenantId, appId, buildId, logBuffer);
    await prisma.build.update({
      where: { id: buildId },
      data: {
        status: "DONE",
        deployResult: deployResult as never,
        deployedAt: new Date(),
        finishedAt: new Date(),
        logsStorageKey: logsKey,
      },
    });
    await publishProgress({
      jobId,
      current: TOTAL_STEPS,
      total: TOTAL_STEPS,
      step: "done",
      level: "info",
    });
    await recordAudit({
      action: "build.deploy",
      target: `app:${appId}`,
      appId,
      outcome: "SUCCESS",
      diff: { buildId, target, platform },
    });
    return { buildId, status: "DONE", deployResult };
  } catch (err: unknown) {
    const cancelled = err instanceof JobCancelledError || ac.signal.aborted;
    logsKey = await persistLog(input.tenantId, appId, buildId, logBuffer);
    if (cancelled) {
      await markBuild({
        status: "CANCELLED",
        failedPhase: phase,
        finishedAt: new Date(),
        logsStorageKey: logsKey,
      });
      throw new JobCancelledError(jobId);
    }
    const message = err instanceof Error ? err.message : String(err);
    // Errors live at the END of build output — keep the tail, not the head.
    const summary = message.length > 2400 ? `…${message.slice(-2400)}` : message;
    await markBuild({
      status: "FAILED",
      failedPhase: phase,
      errorSummary: summary,
      finishedAt: new Date(),
      logsStorageKey: logsKey,
    });
    await recordAudit({
      action: "build.deploy",
      target: `app:${appId}`,
      appId,
      outcome: "FAILURE",
      errorCode: "BUILD_FAILED",
      diff: { buildId, failedPhase: phase, message: message.slice(0, 500) },
    });
    throw err;
  } finally {
    clearInterval(poller);
    if (appleP8Path) await fs.rm(appleP8Path, { force: true }).catch(() => undefined);
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Guarantees the platform's native project (ios/ or android/) exists before
 * building. Managed/partial Expo apps ship without one — `expo prebuild`
 * generates it (no-code). Other frameworks without the dir fail fast with an
 * actionable message rather than a confusing deep tool error.
 */
async function ensureNativeProject(
  projectRoot: string,
  framework: Framework,
  platform: "IOS" | "ANDROID",
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  const dirName = platform === "IOS" ? "ios" : "android";
  const nativeDir = path.join(projectRoot, dirName);
  try {
    await fs.access(nativeDir);
    return; // already present
  } catch {
    /* missing — handle below */
  }

  if (framework === "EXPO" || framework === "REACT_NATIVE") {
    const plat = platform === "IOS" ? "ios" : "android";
    onLine(`No ${dirName}/ found — generating it with \`expo prebuild --platform ${plat}\`…`);
    await runProcess("npx", ["expo", "prebuild", "--platform", plat, "--no-install"], {
      cwd: projectRoot,
      env,
      signal,
      onLine: (l) => onLine(l),
      timeoutMs: 10 * 60_000,
    });
    try {
      await fs.access(nativeDir);
    } catch {
      throw new Error(
        `expo prebuild ran but no ${dirName}/ project was produced. The app may not support ${platform}.`,
      );
    }
    return;
  }

  throw new Error(
    `This project has no ${dirName}/ directory, so a ${platform} build isn't possible here. ` +
      `Point the build source at the ${platform === "IOS" ? "iOS" : "Android"} project, or add native code.`,
  );
}

function appleClientFor(apple: {
  keyId: string;
  issuerId: string;
  p8Path: string;
}): Promise<AppleClient> {
  return fs.readFile(apple.p8Path, "utf8").then(
    (p8) =>
      new AppleClient(new AppleAuth(), {
        id: "deploy",
        keyId: apple.keyId,
        issuerId: apple.issuerId,
        privateKeyPem: p8,
      }),
  );
}

/**
 * App Store pre-flight (before the ~20-min archive). Confirms a key is connected
 * and can publish THIS project's real bundle id, resolves the App Store Connect
 * app id, and checks the key has provisioning rights (App Manager/Admin, not
 * Developer). Fails fast with a clear message on a wrong key / wrong app /
 * insufficient role / invalid key. Returns the resolved storeAppId.
 */
async function resolveAppStoreApp(
  apple: { keyId: string; issuerId: string; p8Path: string } | null,
  bundleId: string | undefined,
  log: (l: string) => void,
): Promise<{ storeAppId: string | null; teamId: string | null }> {
  if (!apple) {
    throw new Error(
      "The App Store target requires an App Store Connect API key. Connect one (Credentials → " +
        "Apple) for the team that owns this app, then deploy again. Firebase App Distribution " +
        "works without it.",
    );
  }
  if (!bundleId) return { storeAppId: null, teamId: null };
  log("Verifying the App Store Connect key can publish this app…");
  let client: AppleClient;
  let apps: { bundleId: string; storeAppId: string }[];
  try {
    client = await appleClientFor(apple);
    apps = await new AppleApps(client).listApps();
  } catch (err) {
    // A key Apple REJECTS (bad keyId/issuer/.p8) is definitively broken — fail
    // fast. Only a genuinely transient error is allowed to proceed.
    if (err instanceof CredentialInvalidError) {
      throw new Error(
        "Apple rejected this App Store Connect key (check the key id, issuer id, and .p8 in " +
          "Credentials → Apple), then redeploy.",
        { cause: err },
      );
    }
    log(
      `Note: couldn't pre-check App Store Connect access (${err instanceof Error ? err.message : String(err)}); continuing.`,
    );
    return { storeAppId: null, teamId: null };
  }
  const match = apps.find((a) => a.bundleId.toLowerCase() === bundleId.toLowerCase());
  if (!match) {
    const sample = apps
      .slice(0, 8)
      .map((a) => a.bundleId)
      .join(", ");
    throw new Error(
      `Your App Store Connect key can't publish ${bundleId} — that bundle id isn't on the key's ` +
        `team. The key currently sees: ${sample || "(no apps)"}. Connect the right key ` +
        `(Credentials → Apple) or register ${bundleId} in App Store Connect; or use Firebase.`,
    );
  }
  // Resolve the signing TEAM straight from the credential (the bundle id's
  // seedId) — fully credential-driven, works even if the project has no
  // DEVELOPMENT_TEAM set.
  let teamId: string | null = null;
  try {
    const res = await client.request<{ data: { attributes: { seedId?: string } }[] }>({
      method: "GET",
      path: "/bundleIds",
      query: { "filter[identifier]": bundleId, limit: 1 },
    });
    const seed = res.data[0]?.attributes.seedId;
    if (seed && /^[A-Z0-9]{10}$/.test(seed)) teamId = seed;
  } catch {
    /* best-effort — the archive/pbxproj team still applies */
  }
  // Provisioning-rights probe: a Developer-role key can list apps but can't
  // create distribution profiles, so it sails through then dies at export.
  // GET /v1/profiles is forbidden to Developer-role keys.
  try {
    await client.request<unknown>({ method: "GET", path: "/profiles", query: { limit: 1 } });
  } catch (err) {
    if (err instanceof CredentialInvalidError) {
      throw new Error(
        `This App Store Connect key can see ${bundleId} but lacks provisioning rights — App Store ` +
          `distribution needs an App Manager or Admin key. Regenerate it in App Store Connect → ` +
          `Users and Access → Integrations with the App Manager role.`,
        { cause: err },
      );
    }
    // Non-auth error on the probe → don't block (network/transient).
  }
  log(
    `App Store Connect key verified for ${bundleId} (app ${match.storeAppId}` +
      (teamId ? `, team ${teamId}` : "") +
      ").",
  );
  return { storeAppId: match.storeAppId, teamId };
}

/**
 * Polls App Store Connect after altool until the uploaded build leaves
 * PROCESSING — so a build Apple rejects (bad signature, missing keys, export
 * compliance) surfaces as a failure instead of a false green DONE.
 */
async function pollAppStoreProcessing(
  apple: { keyId: string; issuerId: string; p8Path: string },
  storeAppId: string | null,
  version: string | null,
  buildNumber: string,
  signal: AbortSignal,
  log: (l: string) => void,
): Promise<{ id: string; processingState: string } | null> {
  if (!storeAppId) return null; // no app id resolved — can't poll
  let builds: AppleBuilds;
  try {
    builds = new AppleBuilds(await appleClientFor(apple));
  } catch {
    return null;
  }
  const deadline = Date.now() + 25 * 60_000;
  const interval = 20_000;
  for (let i = 0; Date.now() < deadline; i++) {
    if (signal.aborted) return null;
    let list: { id: string; buildNumber: string; version: string; processingState: string }[];
    try {
      list = await builds.listBuilds(storeAppId);
    } catch {
      await sleep(interval);
      continue;
    }
    const mine =
      list.find(
        (b) =>
          b.buildNumber === buildNumber && (!version || b.version === version || b.version === ""),
      ) ?? list.find((b) => b.buildNumber === buildNumber);
    if (mine && mine.processingState !== "PROCESSING") {
      return { id: mine.id, processingState: mine.processingState };
    }
    if (i % 3 === 0)
      log(`Apple is processing build ${buildNumber}… (${mine?.processingState ?? "queued"})`);
    await sleep(interval);
  }
  log("Apple is still processing — it'll appear in TestFlight once done.");
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The highest build number ever assigned to this app (parsed from the String
 *  column) so the next build is +1 — monotonic across all builds, including
 *  failed ones, so a number is never reused. */
async function highestBuildNumber(appId: string): Promise<number> {
  const rows = await prisma.build.findMany({
    where: { appId, buildNumber: { not: null } },
    select: { buildNumber: true },
  });
  // The practical ceiling for CFBundleVersion / Android versionCode is ~2.1e9.
  // Ignore non-numeric or absurd values so a single bad/imported row can't
  // poison max() and force every later build into a store-rejected number.
  const CEILING = 2_100_000_000;
  let max = 0;
  for (const r of rows) {
    const raw = r.buildNumber ?? "";
    if (!/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (n <= CEILING && n > max) max = n;
  }
  return max;
}

async function persistLog(
  tenantId: string,
  appId: string,
  buildId: string,
  lines: string[],
): Promise<string | null> {
  try {
    const key = tenantStorageKey(tenantId, "apps", appId, "builds", buildId, "build.log");
    await storage.putBuffer(key, Buffer.from(lines.join("\n"), "utf8"), {
      contentType: "text/plain",
    });
    return key;
  } catch {
    return null; // logging is best-effort
  }
}

function humanPhase(status: BuildStatus): string {
  const map: Partial<Record<BuildStatus, string>> = {
    CLONING: "Preparing source…",
    DETECTING: "Detecting framework…",
    INSTALLING_DEPS: "Installing dependencies…",
    BUILDING: "Building…",
    SIGNING: "Signing…",
    UPLOADING_ARTIFACT: "Uploading artifact…",
    DEPLOYING: "Distributing…",
    DONE: "Done",
  };
  return map[status] ?? status;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
