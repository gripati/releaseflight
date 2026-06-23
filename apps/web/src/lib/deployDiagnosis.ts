/**
 * AI deploy-failure diagnostician.
 *
 * Turns a failed Build (its log + context) into a precise, token-bounded
 * AiTask that asks the tenant's configured LLM for a root-cause analysis, a
 * fix, and a ready-to-paste prompt for a coding assistant. Token-optimised:
 * the giant xcodebuild/gradle log is distilled to the signal lines + the tail.
 */
import { z } from "zod";
import type { AiTask } from "@marquee/aso";

export const DeployDiagnosisCategory = z.enum([
  "PROJECT_CONFIG", // the user's app project needs a change (build settings, code, pods)
  "CREDENTIALS", // an Apple/Google/Firebase key/team/permission problem
  "USER_ACTION", // user must do something outside code (register device, enable API, grant role)
  "TOOLCHAIN", // missing/old tool on the runner (JDK, Android SDK, CocoaPods, Xcode)
  "MARQUEE_BUG", // Release Flight's pipeline itself is at fault
  "TRANSIENT", // network/flake — just retry
]);
export type DeployDiagnosisCategory = z.infer<typeof DeployDiagnosisCategory>;

export const DeployDiagnosis = z.object({
  category: DeployDiagnosisCategory,
  confidence: z.number().int().min(0).max(100),
  rootCause: z.string().max(400),
  summary: z.string().max(400),
  /** Markdown: what happened and why, in plain language. */
  explanation: z.string().max(2600),
  /** Concrete steps the user should take (mainly for USER_ACTION/CREDENTIALS). */
  userSteps: z.array(z.string().max(400)).max(8),
  /** Relevant files/paths/settings to inspect. */
  filesToCheck: z.array(z.string().max(240)).max(10),
  /** A ready-to-paste prompt for an AI coding assistant (Claude Code / Cursor)
   *  opened in the user's project. Empty when the fix is not code/project. */
  llmPrompt: z.string().max(3200),
});
export type DeployDiagnosis = z.infer<typeof DeployDiagnosis>;

const DIAGNOSIS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "category",
    "confidence",
    "rootCause",
    "summary",
    "explanation",
    "userSteps",
    "filesToCheck",
    "llmPrompt",
  ],
  properties: {
    category: {
      type: "string",
      enum: ["PROJECT_CONFIG", "CREDENTIALS", "USER_ACTION", "TOOLCHAIN", "MARQUEE_BUG", "TRANSIENT"],
    },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    rootCause: { type: "string", maxLength: 400 },
    summary: { type: "string", maxLength: 400 },
    explanation: { type: "string", maxLength: 2600 },
    userSteps: { type: "array", maxItems: 8, items: { type: "string", maxLength: 400 } },
    filesToCheck: { type: "array", maxItems: 10, items: { type: "string", maxLength: 240 } },
    llmPrompt: { type: "string", maxLength: 3200 },
  },
};

/**
 * Distil a huge build log into a compact, high-signal excerpt for the LLM.
 * Keeps every error/signal line plus the tail, deduped and capped.
 */
export function extractLogExcerpt(fullLog: string, errorSummary: string | null, maxChars = 9000): string {
  const lines = fullLog.split(/\r?\n/);
  const SIGNAL =
    /error:|fatal|\bFAILED\b|\*\* .* FAILED \*\*|The following build commands failed|No profiles|provisioning|signing|certificate|cannot |could not |not found|unable to|Undefined symbol|linker command|Command .* failed|exit code|Multiple commands produce|requires|denied|unauthorized|Unicode|exit \d+/i;
  const signal: string[] = [];
  for (const l of lines) {
    if (SIGNAL.test(l) && l.trim().length > 0) signal.push(l.trim());
  }
  const tail = lines.slice(-60).map((l) => l.trim()).filter(Boolean);

  // De-dup while preserving order; signal lines first, then the tail.
  const seen = new Set<string>();
  const pick: string[] = [];
  const add = (l: string): void => {
    if (l.length > 600) l = `${l.slice(0, 600)}…`;
    if (!seen.has(l)) {
      seen.add(l);
      pick.push(l);
    }
  };
  signal.forEach(add);
  add("— end of build output —");
  tail.forEach(add);

  let excerpt = pick.join("\n");
  if (excerpt.length > maxChars) excerpt = `…${excerpt.slice(-maxChars)}`;
  if (excerpt.trim().length < 40 && errorSummary) excerpt = errorSummary;
  return excerpt;
}

export interface DiagnosisContext {
  appName: string;
  bundleId: string;
  platform: "IOS" | "ANDROID";
  target: string;
  framework: string | null;
  failedPhase: string | null;
  teamId: string | null;
  localPath: string | null;
  workdirSubpath: string | null;
  errorSummary: string | null;
  logExcerpt: string;
}

const SYSTEM_PROMPT = `You are a world-class mobile CI/CD diagnostician embedded in "Release Flight" — a build & ship system. Release Flight takes a mobile app project (local folder or git), auto-detects the framework (React Native / Expo / Flutter / iOS-native / Android-native), then:
- iOS: pod install → xcodebuild archive → xcodebuild -exportArchive (ExportOptions method release-testing for Firebase, app-store-connect for TestFlight/App Store) → IPA. Release Flight already auto-injects the team it reads from the BUILT ARCHIVE into ExportOptions.teamID, so "DEVELOPMENT_TEAM not set" is almost NEVER the real cause once an archive exists.
- Android: gradle/flutter → APK/AAB, signed with a keystore.
Then it distributes to Firebase App Distribution / App Store Connect (one "App Store" target — the build lands in TestFlight for testers and is submittable for App Store review) / Google Play.

CRITICAL iOS signing knowledge (do NOT default to "DEVELOPMENT_TEAM not set" — Release Flight already injects the team, and the archive succeeding proves it is set):
- ARCHIVE ok then EXPORT failing with "Automatic signing cannot update bundle identifier" / "No profiles for <bundle> were found" / "No Accounts error" is a SIGNING/PROVISIONING problem at export, not a missing team.
- Firebase (method release-testing / ad-hoc): the Mac's local Apple Distribution identity + -allowProvisioningUpdates is enough — this path usually works even when app-store does not.
- TestFlight & App Store (method app-store-connect): the export creates an App Store provisioning profile via -allowProvisioningUpdates using the App Store Connect API key (or a signed-in Xcode account). Likely causes when it fails, in order:
  1) FIRST-TIME PROFILE CREATION RACE — allowProvisioningUpdates created the App Store profile but the same invocation didn't use it ("No profiles were found" on the first try). Release Flight now RETRIES the key automatically; tell the user to simply re-run the deploy. This is the MOST common cause and is TRANSIENT, category TRANSIENT.
  2) ASC KEY ROLE — the key needs App Manager or Admin to create distribution profiles; a Developer-role key can read apps but can't provision. category CREDENTIALS / USER_ACTION (regenerate the key with App Manager role).
  3) The Mac's Xcode account isn't signed in ("No Accounts error") — only matters as the fallback; the ASC key path is primary.
  Note: the team is usually CONSISTENT (project, archive, app on App Store Connect all the same team) — verify before claiming a mismatch. Firebase App Distribution works with the current signing as an alternative.

You are given a FAILED build's context and a distilled log excerpt. Find the single most-likely ROOT CAUSE (not surface symptoms) and produce an actionable fix.

Rules:
- Be precise and specific. Quote the exact error and name exact files/settings/bundle ids/teams.
- category: PROJECT_CONFIG (the app project must change), CREDENTIALS (Apple/Google/Firebase key/team/permission), USER_ACTION (something in a portal/console — register a device, enable an API, grant a role), TOOLCHAIN (missing tool on the build machine), MARQUEE_BUG (Release Flight's own pipeline), or TRANSIENT (retry).
- explanation: a tight markdown analysis — what failed, why, and the chain of cause. No fluff.
- userSteps: concrete steps the human must do (portal clicks, exact values). Use when the fix is outside code.
- llmPrompt: ONLY when the fix is in the user's PROJECT code/config. Write a complete, self-contained prompt the developer can paste into an AI coding assistant (Claude Code / Cursor) opened in their project. Include the project path, the exact error, the root cause, and precise instructions (which file, which setting, what to change). If the fix is NOT code (credentials/portal/device), set llmPrompt to "".
- Never invent log lines. If uncertain, lower confidence and say what to check.`;

export function buildDiagnosisTask(ctx: DiagnosisContext): AiTask<DiagnosisContext, DeployDiagnosis> {
  const userPrompt = `A Release Flight deploy FAILED. Diagnose it.

App: ${ctx.appName}  (bundle id: ${ctx.bundleId})
Platform: ${ctx.platform}   Target: ${ctx.target}   Framework: ${ctx.framework ?? "unknown"}
Failed phase: ${ctx.failedPhase ?? "unknown"}
Signing team (DEVELOPMENT_TEAM): ${ctx.teamId ?? "not set"}
Project location: ${ctx.localPath ?? "(git)"}${ctx.workdirSubpath ? ` / subfolder: ${ctx.workdirSubpath}` : ""}

${ctx.errorSummary ? `Reported error:\n${ctx.errorSummary}\n\n` : ""}Distilled build log (signal lines + tail):
\`\`\`
${ctx.logExcerpt}
\`\`\`

Return the structured diagnosis.`;

  return {
    kind: "deploy.diagnose",
    input: ctx,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    outputSchema: DeployDiagnosis,
    jsonSchema: DIAGNOSIS_JSON_SCHEMA,
    taskName: "deploy_diagnosis",
    taskDescription: "Root-cause analysis of a failed mobile build/deploy with a concrete fix.",
    maxOutputTokens: 1500,
    temperature: 0.1,
  };
}
