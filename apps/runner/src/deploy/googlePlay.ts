/**
 * Google Play deploy tail — uploads an AAB and assigns it to a track.
 * Reuses the existing @marquee/core Google adapters (pure HTTP, runs anywhere).
 */
import fs from "node:fs/promises";
import {
  GoogleAab,
  GoogleAuth,
  GoogleClient,
  GoogleTracks,
  GOOGLE_SCOPES,
  type ReleaseStatus,
  type TrackName,
} from "@marquee/core";
import type { GoogleStoreCredential } from "../credentials/loadBuildCredentials";

export async function uploadToGooglePlay(ctx: {
  aabPath: string;
  packageName: string;
  google: GoogleStoreCredential;
  track: TrackName;
  status: ReleaseStatus;
  userFraction?: number;
  releaseNotes?: string;
  onLine?: (line: string) => void;
}): Promise<{ versionCode: number; track: string }> {
  const client = new GoogleClient(
    new GoogleAuth(),
    {
      id: `play:${ctx.packageName}`,
      clientEmail: ctx.google.clientEmail,
      privateKeyPem: ctx.google.privateKeyPem,
      projectId: ctx.google.projectId,
    },
    GOOGLE_SCOPES.ANDROID_PUBLISHER,
  );

  const buf = await fs.readFile(ctx.aabPath);
  ctx.onLine?.(`Uploading AAB (${(buf.length / 1e6).toFixed(1)} MB) to Google Play…`);
  const { versionCode } = await new GoogleAab(client).uploadAab({
    packageName: ctx.packageName,
    fileBuffer: buf,
  });

  ctx.onLine?.(`Assigning version ${versionCode.toString()} to the ${ctx.track} track…`);
  await new GoogleTracks(client).assignBundle({
    packageName: ctx.packageName,
    trackName: ctx.track,
    versionCodes: [versionCode],
    status: ctx.status,
    userFraction: ctx.userFraction,
    releaseNotes: ctx.releaseNotes ? [{ language: "en-US", text: ctx.releaseNotes }] : undefined,
  });

  return { versionCode, track: ctx.track };
}
