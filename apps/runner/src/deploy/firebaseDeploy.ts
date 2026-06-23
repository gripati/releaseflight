/**
 * Firebase App Distribution deploy tail.
 *
 * Primary path: the pure-HTTP REST adapter (packages/core). Fallback: the
 * Firebase CLI (`firebase appdistribution:distribute`), mirroring the proven
 * Unity GamePublisher behaviour when the REST upload fails.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FirebaseAppDistribution, FirebaseClient, GoogleAuth } from "@marquee/core";
import type { FirebaseConnection } from "../credentials/loadBuildCredentials";
import { runProcess, tryProcess } from "../build/runProcess";

export interface FirebaseDeployResult {
  releaseName: string;
  consoleUri?: string;
  via: "rest" | "cli";
}

export async function deployToFirebase(opts: {
  artifactPath: string;
  platform: "IOS" | "ANDROID";
  firebase: FirebaseConnection;
  releaseNotes?: string;
  /** Per-deploy tester group aliases chosen in the launcher. Falls back to the
   *  connection's saved groups when empty/undefined. */
  groupAliases?: string[];
  /** Per-deploy ad-hoc tester emails chosen in the launcher. */
  testerEmails?: string[];
  onLine?: (line: string) => void;
  onTick?: (ms: number) => void;
  signal?: AbortSignal;
}): Promise<FirebaseDeployResult> {
  const firebaseAppId =
    opts.platform === "IOS" ? opts.firebase.iosAppId : opts.firebase.androidAppId;
  if (!firebaseAppId) {
    throw new Error(
      `Firebase ${opts.platform} app id is not set on the Firebase connection. Add it in the Deploy tab.`,
    );
  }

  // The launcher selection is authoritative when present — an explicit empty
  // array means "upload only, don't release". Only when the field is entirely
  // absent (e.g. an API client that didn't specify) do we fall back to the
  // connection's saved default groups.
  const groupAliases = opts.groupAliases ?? opts.firebase.testerGroups;
  const testerEmails = opts.testerEmails ?? [];
  const audience = describeAudience(groupAliases, testerEmails);

  const client = new FirebaseClient(new GoogleAuth(), {
    id: `firebase:${firebaseAppId}`,
    clientEmail: opts.firebase.clientEmail,
    privateKeyPem: opts.firebase.privateKeyPem,
    projectId: opts.firebase.projectId ?? undefined,
  });
  const fad = new FirebaseAppDistribution(client);

  // ── Upload (REST) ────────────────────────────────────────────────────
  // The CLI fallback re-uploads the artifact, so it is only safe BEFORE a
  // release exists. Once we have a release name, notes/distribute failures
  // must NOT fall back (that would create a second, orphaned release).
  let release: { releaseName: string; consoleUri?: string };
  try {
    const body = await fs.readFile(opts.artifactPath);
    opts.onLine?.(
      `Uploading ${path.basename(opts.artifactPath)} (${(body.length / 1e6).toFixed(1)} MB) to Firebase…`,
    );
    const { operationName } = await fad.uploadRelease({
      firebaseAppId,
      body,
      fileName: path.basename(opts.artifactPath),
      signal: opts.signal,
    });
    release = await fad.pollUploadOperation(operationName, {
      onTick: opts.onTick,
      signal: opts.signal,
    });
  } catch (uploadErr: unknown) {
    // If the user cancelled, do NOT fall back to a full CLI re-upload — that
    // would re-send the whole artifact and could still distribute it.
    if (opts.signal?.aborted) throw uploadErr;
    const msg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
    opts.onLine?.(`REST upload failed (${msg}); falling back to Firebase CLI…`);
    return deployViaCli({
      artifactPath: opts.artifactPath,
      firebaseAppId,
      firebase: opts.firebase,
      releaseNotes: opts.releaseNotes,
      groupAliases,
      testerEmails,
      restError: msg,
      onLine: opts.onLine,
      signal: opts.signal,
    });
  }

  // ── Notes (cosmetic — must NOT fail an already-uploaded build) ───────
  if (opts.releaseNotes) {
    try {
      await fad.setReleaseNotes(release.releaseName, opts.releaseNotes);
    } catch (notesErr: unknown) {
      const m = notesErr instanceof Error ? notesErr.message : String(notesErr);
      opts.onLine?.(`Note: couldn't set release notes (${m}) — continuing.`);
    }
  }

  // ── Distribute (REST only — never re-uploads on failure) ─────────────
  if (groupAliases.length > 0 || testerEmails.length > 0) {
    try {
      await fad.distribute({ releaseName: release.releaseName, groupAliases, testerEmails });
    } catch (distErr: unknown) {
      const msg = distErr instanceof Error ? distErr.message : String(distErr);
      throw new Error(
        `Uploaded to Firebase, but releasing to ${audience} failed: ${msg}. The build is in Firebase — ` +
          `retry, or assign testers in the console. (Not re-uploaded to avoid a duplicate release.)`,
        { cause: distErr },
      );
    }
  }
  opts.onLine?.(`Released to ${audience}.`);
  return { releaseName: release.releaseName, consoleUri: release.consoleUri, via: "rest" };
}

/** Human label for the build-log line, e.g. "2 group(s): qa, beta + 1 tester". */
function describeAudience(groups: string[], emails: string[]): string {
  const parts: string[] = [];
  if (groups.length > 0) parts.push(`${groups.length.toString()} group(s): ${groups.join(", ")}`);
  if (emails.length > 0) parts.push(`${emails.length.toString()} tester(s)`);
  return parts.length > 0 ? parts.join(" + ") : "no testers (upload only — assign in the console)";
}

async function deployViaCli(opts: {
  artifactPath: string;
  firebaseAppId: string;
  firebase: FirebaseConnection;
  releaseNotes?: string;
  groupAliases: string[];
  testerEmails: string[];
  restError?: string;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<FirebaseDeployResult> {
  // Surface a clear message if the CLI isn't installed, instead of a bare ENOENT.
  if (!(await tryProcess("firebase", ["--version"], {}))) {
    throw new Error(
      `Firebase upload failed (${opts.restError ?? "REST error"}) and the Firebase CLI fallback ` +
        `isn't installed. Install it (npm i -g firebase-tools) or fix the REST cause above.`,
    );
  }
  const saFile = path.join(os.tmpdir(), `mq-firebase-sa-${randomUUID()}.json`);
  await fs.writeFile(saFile, opts.firebase.serviceAccountJson, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: saFile };

  const args = ["appdistribution:distribute", opts.artifactPath, "--app", opts.firebaseAppId];
  if (opts.groupAliases.length > 0) {
    args.push("--groups", opts.groupAliases.join(","));
  }
  if (opts.testerEmails.length > 0) {
    args.push("--testers", opts.testerEmails.join(","));
  }
  if (opts.releaseNotes) {
    args.push("--release-notes", opts.releaseNotes);
  }

  let consoleUri: string | undefined;
  try {
    const res = await runProcess("firebase", args, {
      env,
      signal: opts.signal,
      timeoutMs: 15 * 60_000,
      onLine: (line) => {
        opts.onLine?.(line);
        const m = /https:\/\/appdistribution\.firebase\.\S+/.exec(line);
        if (m) consoleUri = m[0];
      },
    });
    void res;
    return { releaseName: consoleUri ?? "(distributed via CLI)", consoleUri, via: "cli" };
  } finally {
    await fs.rm(saFile, { force: true }).catch(() => undefined);
  }
}
