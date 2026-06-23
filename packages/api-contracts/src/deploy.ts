import { z } from "zod";
import { Uuid, Platform } from "./common";

// ── Enums ────────────────────────────────────────────────────────────────

/** Per-app connection kinds stored in AppConnection. APPLE/GOOGLE reuse the
 *  tenant-wide Credential table and are not AppConnection kinds. */
export const AppConnectionKind = z.enum(["GIT", "FIREBASE", "ANDROID_KEYSTORE"]);
export type AppConnectionKind = z.infer<typeof AppConnectionKind>;

export const DeployTargetKind = z.enum([
  "FIREBASE_APP_DISTRIBUTION",
  "APPLE_TESTFLIGHT",
  "APPLE_APP_STORE",
  "GOOGLE_PLAY",
]);
export type DeployTargetKind = z.infer<typeof DeployTargetKind>;

/** The full set of things a card may ask the user to connect, spanning both
 *  AppConnection kinds and the tenant Credential kinds (APPLE/GOOGLE). */
export type RequiredConnection = "GIT" | "APPLE" | "GOOGLE" | "FIREBASE" | "ANDROID_KEYSTORE";

/** Which connections are required for a given platform + target — drives the
 *  no-code wizard (only the needed cards appear, gated behind a ready banner). */
export function requiredConnections(
  platform: Platform,
  target: DeployTargetKind,
): RequiredConnection[] {
  const reqs: RequiredConnection[] = ["GIT"];
  switch (target) {
    case "FIREBASE_APP_DISTRIBUTION":
      // iOS Firebase needs NO Apple credential: the runner signs the IPA with
      // the Mac's local distribution identity (an ASC key is optional). Android
      // needs a keystore to sign. Both need the Firebase connection.
      if (platform === "IOS") reqs.push("FIREBASE");
      else reqs.push("ANDROID_KEYSTORE", "FIREBASE");
      break;
    case "APPLE_TESTFLIGHT":
    case "APPLE_APP_STORE":
      reqs.push("APPLE");
      break;
    case "GOOGLE_PLAY":
      reqs.push("GOOGLE", "ANDROID_KEYSTORE");
      break;
  }
  return reqs;
}

// ── Connection DTO + requests ────────────────────────────────────────────
export const ConnectionStatus = z.enum(["NOT_CONNECTED", "CONNECTED", "ERROR"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const AppConnectionDto = z.object({
  id: Uuid,
  appId: Uuid,
  kind: AppConnectionKind,
  status: ConnectionStatus,
  /** Non-secret summary for display (repoUrl, branch, publicKey, iosAppId, …). */
  metadata: z.record(z.unknown()).nullable(),
  lastTestedAt: z.string().datetime().nullable(),
  lastTestSucceeded: z.boolean().nullable(),
  lastTestMessage: z.string().nullable(),
});
export type AppConnectionDto = z.infer<typeof AppConnectionDto>;

/**
 * Hardened git repository URL. Beyond requiring an SSH (`git@host:org/repo.git`)
 * or HTTP(S) form, it explicitly rejects git's command-executing transports —
 * any `::` sequence (e.g. `ext::sh -c …`, `fd::`) and option-injection (leading
 * `-`). Reused by BOTH the create body and the metadata update body so the two
 * can never drift: a loose update schema was an authenticated-to-RCE path (the
 * runner clones whatever `repoUrl` is stored). Length-capped to bound abuse.
 */
export const GitRepoUrl = z
  .string()
  .min(4)
  .max(512)
  .refine(
    (s) =>
      !s.includes("::") &&
      !s.trimStart().startsWith("-") &&
      (/^git@[^:]+:.+\.git$/.test(s) || /^https?:\/\/.+/.test(s)),
    "Use an SSH (git@host:org/repo.git) or HTTPS repository URL.",
  );

/**
 * A git branch/ref/tag. Conservative charset (reject a leading `-` so it can't
 * be read as a git option, `..` range syntax, spaces, and control chars). Used
 * everywhere a ref flows toward `git clone --branch <ref>` on the runner.
 */
export const GitRef = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/, "Invalid git ref")
  .refine((s) => !s.startsWith("-") && !s.includes(".."), "Invalid git ref");

const GitConnectionBody = z.object({
  kind: z.literal("GIT"),
  repoUrl: GitRepoUrl,
  branch: GitRef.default("main"),
});

const FirebaseConnectionBody = z.object({
  kind: z.literal("FIREBASE"),
  serviceAccountJson: z
    .string()
    .min(40)
    .refine((s) => {
      try {
        const p = JSON.parse(s) as { client_email?: string; private_key?: string };
        return Boolean(p.client_email && p.private_key);
      } catch {
        return false;
      }
    }, "Must be a valid Firebase service-account JSON (with client_email + private_key)."),
  iosAppId: z.string().regex(/^\d+:\d+:ios:[0-9a-f]+$/i).optional(),
  androidAppId: z.string().regex(/^\d+:\d+:android:[0-9a-f]+$/i).optional(),
  testerGroups: z.array(z.string()).default([]),
});

const KeystoreConnectionBody = z.object({
  kind: z.literal("ANDROID_KEYSTORE"),
  keystoreBase64: z.string().min(40),
  storePassword: z.string().min(1),
  keyPassword: z.string().min(1),
  keyAlias: z.string().min(1),
  usePlayAppSigning: z.boolean().default(false),
});

export const CreateConnectionRequest = z.discriminatedUnion("kind", [
  GitConnectionBody,
  FirebaseConnectionBody,
  KeystoreConnectionBody,
]);
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequest>;

/**
 * Lightweight metadata-only update for an existing connection — lets the user
 * tweak non-secret fields (Firebase app ids, branch, tester groups) WITHOUT
 * re-uploading the secret (service account / keystore / deploy key). Keeps an
 * already-saved connection stable: editing never forces a full reconnect.
 */
export const UpdateConnectionRequest = z.object({
  repoUrl: GitRepoUrl.optional(),
  branch: GitRef.optional(),
  iosAppId: z
    .string()
    .regex(/^\d+:\d+:ios:[0-9a-f]+$/i)
    .or(z.literal(""))
    .nullable()
    .optional(),
  androidAppId: z
    .string()
    .regex(/^\d+:\d+:android:[0-9a-f]+$/i)
    .or(z.literal(""))
    .nullable()
    .optional(),
  testerGroups: z.array(z.string()).optional(),
});
export type UpdateConnectionRequest = z.infer<typeof UpdateConnectionRequest>;

export const TestConnectionResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  testedAt: z.string().datetime(),
  // kind-specific extras
  branchExists: z.boolean().optional(),
  testerGroups: z.array(z.object({ alias: z.string(), displayName: z.string() })).optional(),
  aliasFound: z.boolean().optional(),
});
export type TestConnectionResult = z.infer<typeof TestConnectionResult>;

export const DeployKeyResponse = z.object({ publicKey: z.string() });
export type DeployKeyResponse = z.infer<typeof DeployKeyResponse>;

// ── Build config (source: local folder vs git) ──────────────────────────
export const BuildConfigDto = z.object({
  appId: Uuid,
  source: z.enum(["LOCAL", "GIT"]),
  localPath: z.string().nullable(),
  gitRef: z.string(),
  workdirSubpath: z.string().nullable(),
  iosScheme: z.string().nullable(),
  /** User-editable marketing version; null = read from project. */
  versionName: z.string().nullable(),
  /** Build number the next deploy will use (editable; auto-bumps after deploy). */
  nextBuildNumber: z.number().int().nullable(),
  autoIncrementBuildNumber: z.boolean(),
});
export type BuildConfigDto = z.infer<typeof BuildConfigDto>;

export const UpdateBuildConfigRequest = z.object({
  /** Absolute path on the runner machine. Set to use a local folder (no
   *  clone). Send null to clear it and fall back to the Git connection. */
  localPath: z.string().trim().nullable().optional(),
  gitRef: GitRef.optional(),
  workdirSubpath: z.string().trim().nullable().optional(),
  /** iOS Xcode scheme to build (e.g. "TERRA"). Null = auto-detect. */
  iosScheme: z.string().trim().nullable().optional(),
  versionName: z.string().trim().max(64).nullable().optional(),
  nextBuildNumber: z.number().int().min(1).max(2_147_483_647).nullable().optional(),
  autoIncrementBuildNumber: z.boolean().optional(),
});
export type UpdateBuildConfigRequest = z.infer<typeof UpdateBuildConfigRequest>;

// ── Deploy launch ────────────────────────────────────────────────────────
/** Single source of truth for tester-email validity — shared by the contract
 *  AND the launcher's client-side filter so the two can never drift (a mismatch
 *  would let a bad email pass the UI then 400 the whole deploy). */
export const TesterEmail = z.string().email();
export function isTesterEmail(value: string): boolean {
  return TesterEmail.safeParse(value).success;
}

export const DeployRequest = z.object({
  platform: Platform,
  target: DeployTargetKind,
  gitRef: GitRef.optional(),
  releaseNotes: z.string().max(16384).optional(),
  // Versioning — what the user typed in the launcher (overrides the stored next).
  // 1..2^31-1: stores reject 0 and Android versionCode caps at 2147483647.
  versionName: z.string().trim().max(64).optional(),
  buildNumber: z.number().int().min(1).max(2_147_483_647).optional(),
  // Firebase target options
  firebaseGroups: z.array(z.string()).optional(),
  firebaseTesters: z.array(TesterEmail).optional(),
  // Google Play target options
  playTrack: z.enum(["internal", "alpha", "beta", "production"]).optional(),
  playRolloutFraction: z.number().min(0).max(1).optional(),
});
export type DeployRequest = z.infer<typeof DeployRequest>;

export const DeployResponse = z.object({ buildId: Uuid, jobId: Uuid });
export type DeployResponse = z.infer<typeof DeployResponse>;

// ── Firebase tester groups (deploy launcher picker) ──────────────────────
export const FirebaseTesterGroupDto = z.object({
  alias: z.string(),
  displayName: z.string(),
  testerCount: z.number().nullable(),
});
export type FirebaseTesterGroupDto = z.infer<typeof FirebaseTesterGroupDto>;

export const FirebaseGroupsResponse = z.object({
  groups: z.array(FirebaseTesterGroupDto),
  /** Group aliases saved on the connection — pre-selected in the picker. */
  selected: z.array(z.string()),
  /** Set when groups couldn't be listed (e.g. no app id yet). */
  note: z.string().optional(),
});
export type FirebaseGroupsResponse = z.infer<typeof FirebaseGroupsResponse>;

// ── Build history ─────────────────────────────────────────────────────────
export const BuildStatus = z.enum([
  "QUEUED",
  "CLONING",
  "DETECTING",
  "INSTALLING_DEPS",
  "BUILDING",
  "SIGNING",
  "UPLOADING_ARTIFACT",
  "DEPLOYING",
  "DONE",
  "FAILED",
  "CANCELLED",
]);
export type BuildStatus = z.infer<typeof BuildStatus>;

export const BuildSummaryDto = z.object({
  id: Uuid,
  jobId: Uuid.nullable(),
  platform: Platform,
  target: DeployTargetKind,
  frameworkDetected: z.string().nullable(),
  status: BuildStatus,
  versionString: z.string().nullable(),
  buildNumber: z.string().nullable(),
  artifactKind: z.enum(["IPA", "AAB", "APK"]).nullable(),
  artifactAvailable: z.boolean(),
  deployResult: z.record(z.unknown()).nullable(),
  errorSummary: z.string().nullable(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});
export type BuildSummaryDto = z.infer<typeof BuildSummaryDto>;
