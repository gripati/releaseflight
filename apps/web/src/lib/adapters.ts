/**
 * Per-request adapter factory. Reads credential material from the secret
 * provider and constructs the appropriate Apple/Google client. Each
 * worker process shares a single AppleAuth / GoogleAuth singleton so JWT
 * caches survive across requests in the same process.
 */
import {
  AppleApps,
  AppleAuth,
  AppleBuilds,
  AppleClient,
  AppleMetadata,
  AppleScreenshots,
  GOOGLE_SCOPES,
  GoogleAab,
  GoogleAuth,
  GoogleClient,
  GoogleImages,
  GoogleListings,
  GoogleTracks,
} from "@marquee/core";
import { NotFoundError, ValidationError } from "@marquee/core";
import { prisma } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";

const secretProvider = createSecretProvider();
const appleAuth = new AppleAuth();
const googleAuth = new GoogleAuth();

export interface AppleStack {
  apps: AppleApps;
  metadata: AppleMetadata;
  screenshots: AppleScreenshots;
  builds: AppleBuilds;
}

export interface GoogleStack {
  listings: GoogleListings;
  images: GoogleImages;
  aab: GoogleAab;
  tracks: GoogleTracks;
}

async function loadCredentialMaterial(credentialId: string): Promise<{
  kind: "APPLE" | "GOOGLE";
  content: string;
  appleKeyId: string | null;
  appleIssuerId: string | null;
  googleClientEmail: string | null;
  googleProjectId: string | null;
}> {
  const cred = await prisma.credential.findUnique({ where: { id: credentialId } });
  if (!cred) throw new NotFoundError("Credential not found");
  if (!cred.isActive) throw new ValidationError("Credential is inactive");
  if (cred.kind !== "APPLE" && cred.kind !== "GOOGLE") {
    throw new ValidationError(
      `Credential kind ${cred.kind} is not a store credential — load via the AI / Search Ads code paths.`,
    );
  }
  const material = await secretProvider.get(cred.secretRef);
  return {
    kind: cred.kind,
    content: material.content,
    appleKeyId: cred.appleKeyId,
    appleIssuerId: cred.appleIssuerId,
    googleClientEmail: cred.googleClientEmail,
    googleProjectId: cred.googleProjectId,
  };
}

export async function buildAppleStack(credentialId: string): Promise<AppleStack> {
  const cred = await loadCredentialMaterial(credentialId);
  if (cred.kind !== "APPLE") throw new ValidationError("Credential is not APPLE");
  if (!cred.appleKeyId || !cred.appleIssuerId) {
    throw new ValidationError("Apple credential missing keyId / issuerId");
  }
  const client = new AppleClient(appleAuth, {
    id: credentialId,
    keyId: cred.appleKeyId,
    issuerId: cred.appleIssuerId,
    privateKeyPem: cred.content,
  });
  const apps = new AppleApps(client);
  const metadata = new AppleMetadata(client);
  const screenshots = new AppleScreenshots(client);
  const builds = new AppleBuilds(client);
  return { apps, metadata, screenshots, builds };
}

export async function buildGoogleStack(credentialId: string): Promise<GoogleStack> {
  const cred = await loadCredentialMaterial(credentialId);
  if (cred.kind !== "GOOGLE") {
    throw new ValidationError("Credential is not GOOGLE");
  }
  const parsed = JSON.parse(cred.content) as { client_email: string; private_key: string; project_id?: string };
  const client = new GoogleClient(
    googleAuth,
    {
      id: credentialId,
      clientEmail: parsed.client_email,
      privateKeyPem: parsed.private_key,
      ...(parsed.project_id !== undefined ? { projectId: parsed.project_id } : {}),
    },
    GOOGLE_SCOPES.ANDROID_PUBLISHER,
  );
  return {
    listings: new GoogleListings(client),
    images: new GoogleImages(client),
    aab: new GoogleAab(client),
    tracks: new GoogleTracks(client),
  };
}
