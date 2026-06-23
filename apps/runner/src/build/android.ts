/**
 * Android build executors — produce a signed APK (Firebase) or AAB (Play)
 * from Flutter / React Native / Expo-bare / native-Android projects.
 *
 * Requires a JDK + Android SDK on the runner (apksigner/zipalign from the
 * SDK build-tools, gradle via the project's gradlew). Flutter additionally
 * needs the Flutter SDK.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { Framework } from "../detect/detectFramework";
import type { KeystoreConnection } from "../credentials/loadBuildCredentials";
import { runProcess, tryProcess, type RunProcessOptions } from "./runProcess";
import { findNewestBySuffix } from "./findArtifact";
import { cleanMarketingVersion } from "./versioning";

export type AndroidArtifactKind = "APK" | "AAB";

export interface AndroidBuildResult {
  artifactPath: string;
  artifactKind: AndroidArtifactKind;
}

interface BuildCtx {
  projectRoot: string;
  framework: Framework;
  /** APK for Firebase, AAB for Google Play. */
  kind: AndroidArtifactKind;
  androidModule: string;
  keystore: KeystoreConnection | null;
  /** Auto-incremented build number to stamp as versionCode. */
  buildNumber?: string | null;
  /** Marketing version to stamp as versionName. */
  marketingVersion?: string | null;
  env: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export async function buildAndroid(ctx: BuildCtx): Promise<AndroidBuildResult> {
  const procOpts: RunProcessOptions = {
    env: ctx.env,
    onLine: (l) => ctx.onLine?.(l),
    signal: ctx.signal,
    timeoutMs: 40 * 60_000,
  };

  let artifactPath: string | null;

  if (ctx.framework === "FLUTTER") {
    await runProcess("flutter", ["pub", "get"], { ...procOpts, cwd: ctx.projectRoot });
    const sub = ctx.kind === "AAB" ? "appbundle" : "apk";
    const mv = cleanMarketingVersion(ctx.marketingVersion);
    const fArgs = ["build", sub, "--release"];
    if (ctx.buildNumber) fArgs.push(`--build-number=${ctx.buildNumber}`);
    if (mv) fArgs.push(`--build-name=${mv}`);
    await runProcess("flutter", fArgs, { ...procOpts, cwd: ctx.projectRoot });
    artifactPath = findNewestBySuffix(
      path.join(ctx.projectRoot, "build"),
      ctx.kind === "AAB" ? ".aab" : ".apk",
    );
  } else {
    // Gradle-based: native Android (root) or RN/Expo-bare (android/ subdir).
    const androidDir =
      ctx.framework === "ANDROID_NATIVE" ? ctx.projectRoot : path.join(ctx.projectRoot, "android");
    await ensureGradlewExecutable(androidDir);
    const task =
      ctx.kind === "AAB"
        ? `:${ctx.androidModule}:bundleRelease`
        : `:${ctx.androidModule}:assembleRelease`;
    const gradleArgs = [task, "--no-daemon"];
    // AGP-level overrides — stamp versionCode/versionName without editing
    // build.gradle (works whether or not the project hardcodes them).
    const mvg = cleanMarketingVersion(ctx.marketingVersion);
    if (ctx.buildNumber) gradleArgs.push(`-Pandroid.injected.version.code=${ctx.buildNumber}`);
    if (mvg) gradleArgs.push(`-Pandroid.injected.version.name=${mvg}`);
    if (ctx.buildNumber) ctx.onLine?.(`Stamping versionCode ${ctx.buildNumber}`);
    await runProcess("./gradlew", gradleArgs, { ...procOpts, cwd: androidDir });
    const outRoot = path.join(androidDir, ctx.androidModule, "build", "outputs");
    artifactPath = findNewestBySuffix(outRoot, ctx.kind === "AAB" ? ".aab" : ".apk");
  }

  if (!artifactPath) {
    throw new Error(`Build finished but no ${ctx.kind} artifact was found.`);
  }

  // Sign if the artifact looks unsigned, or always for AAB→Play (needs the
  // upload key). Firebase accepts any valid signature, so we only sign an
  // unsigned APK when a keystore is available.
  const isUnsigned = path.basename(artifactPath).includes("unsigned");
  if (ctx.keystore && (ctx.kind === "AAB" || isUnsigned)) {
    artifactPath = await signAndroid(artifactPath, ctx.kind, ctx.keystore, ctx.env, ctx.onLine);
  } else if (isUnsigned && !ctx.keystore) {
    throw new Error(
      "Build produced an unsigned artifact and no Android keystore is connected. Connect a keystore to sign it.",
    );
  }

  return { artifactPath, artifactKind: ctx.kind };
}

async function ensureGradlewExecutable(dir: string): Promise<void> {
  const gw = path.join(dir, "gradlew");
  try {
    await fs.chmod(gw, 0o755);
  } catch {
    /* may already be executable or absent (error surfaces at run time) */
  }
}

/** apksigner for APK (v2/v3 scheme), jarsigner for AAB (only tool that signs bundles). */
async function signAndroid(
  artifactPath: string,
  kind: AndroidArtifactKind,
  ks: KeystoreConnection,
  env: NodeJS.ProcessEnv,
  onLine?: (line: string) => void,
): Promise<string> {
  const ksFile = path.join(os.tmpdir(), `mq-keystore-${randomUUID()}.jks`);
  // Pass keystore passwords via 0600 files, NEVER argv: process arguments are
  // world-readable (`ps -ef`, /proc/<pid>/cmdline) and previously leaked into
  // ProcessError → errorSummary → the UI, audit log and the AI-diagnosis prompt.
  const storePassFile = path.join(os.tmpdir(), `mq-kspw-${randomUUID()}`);
  const keyPassFile = path.join(os.tmpdir(), `mq-keypw-${randomUUID()}`);
  await fs.writeFile(ksFile, ks.keystoreBytes, { mode: 0o600 });
  await fs.writeFile(storePassFile, ks.storePassword, { mode: 0o600 });
  await fs.writeFile(keyPassFile, ks.keyPassword, { mode: 0o600 });
  // Belt-and-suspenders: mask the passwords if any signing tool echoes them.
  const redact = [ks.storePassword, ks.keyPassword];
  try {
    if (kind === "APK") {
      const signed = artifactPath.replace(/(-unsigned)?\.apk$/, "-signed.apk");
      const apksigner = await resolveApksigner(env);
      await runProcess(
        apksigner,
        [
          "sign",
          "--ks",
          ksFile,
          "--ks-pass",
          `file:${storePassFile}`,
          "--ks-key-alias",
          ks.keyAlias,
          "--key-pass",
          `file:${keyPassFile}`,
          "--out",
          signed,
          artifactPath,
        ],
        { env, onLine, redact },
      );
      return signed;
    }
    // AAB → jarsigner in place. The `:file` modifier reads the password from
    // a file rather than taking it on the command line.
    await runProcess(
      "jarsigner",
      [
        "-verbose",
        "-sigalg",
        "SHA256withRSA",
        "-digestalg",
        "SHA-256",
        "-keystore",
        ksFile,
        "-storepass:file",
        storePassFile,
        "-keypass:file",
        keyPassFile,
        artifactPath,
        ks.keyAlias,
      ],
      { env, onLine, redact },
    );
    return artifactPath;
  } finally {
    await fs.rm(ksFile, { force: true }).catch(() => undefined);
    await fs.rm(storePassFile, { force: true }).catch(() => undefined);
    await fs.rm(keyPassFile, { force: true }).catch(() => undefined);
  }
}

/** Find apksigner on PATH or under $ANDROID_HOME/build-tools/<latest>. */
async function resolveApksigner(env: NodeJS.ProcessEnv): Promise<string> {
  const onPath = await tryProcess("apksigner", ["--version"], { env });
  if (onPath) return "apksigner";
  const home = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (home) {
    const buildTools = path.join(home, "build-tools");
    try {
      const versions = (await fs.readdir(buildTools)).sort().reverse();
      for (const v of versions) {
        const candidate = path.join(buildTools, v, "apksigner");
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          /* keep looking */
        }
      }
    } catch {
      /* no build-tools */
    }
  }
  throw new Error("apksigner not found — install the Android SDK build-tools (set ANDROID_HOME).");
}
