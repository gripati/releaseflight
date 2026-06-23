/**
 * Loads the per-app connections the runner needs at build time. Must be
 * called inside a `tenantStorage.run(...)` context so RLS scopes the
 * AppConnection rows to the right tenant.
 *
 * GIT / FIREBASE / ANDROID_KEYSTORE live in `AppConnection`; APPLE / GOOGLE
 * store credentials reuse the tenant-wide `Credential` rows (loaded
 * separately for the store deploy tails).
 */
import { prisma } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";

const secretProvider = createSecretProvider();

export interface GitConnection {
  repoUrl: string;
  branch: string;
  privateKeyPem: string | null;
}

export interface FirebaseConnection {
  serviceAccountJson: string;
  clientEmail: string;
  privateKeyPem: string;
  projectId: string | null;
  iosAppId: string | null;
  androidAppId: string | null;
  testerGroups: string[];
}

export interface KeystoreConnection {
  keystoreBytes: Buffer;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
  usePlayAppSigning: boolean;
}

async function loadRaw(
  appId: string,
  kind: "GIT" | "FIREBASE" | "ANDROID_KEYSTORE",
): Promise<{ metadata: Record<string, unknown>; content: string; secretMeta: Record<string, string> } | null> {
  const conn = await prisma.appConnection.findFirst({ where: { appId, kind } });
  if (!conn) return null;
  const secret = await secretProvider.get(conn.secretRef);
  return {
    metadata: (conn.metadata as Record<string, unknown> | null) ?? {},
    content: secret.content,
    secretMeta: secret.metadata ?? {},
  };
}

export async function loadGitConnection(appId: string): Promise<GitConnection | null> {
  const r = await loadRaw(appId, "GIT");
  if (!r) return null;
  return {
    repoUrl: String(r.metadata.repoUrl ?? ""),
    branch: String(r.metadata.branch ?? "main"),
    privateKeyPem: r.content || null,
  };
}

export async function loadFirebaseConnection(appId: string): Promise<FirebaseConnection | null> {
  const r = await loadRaw(appId, "FIREBASE");
  if (!r) return null;
  const parsed = JSON.parse(r.content) as {
    client_email?: string;
    private_key?: string;
    project_id?: string;
  };
  const groups = r.metadata.testerGroups;
  return {
    serviceAccountJson: r.content,
    clientEmail: parsed.client_email ?? "",
    privateKeyPem: parsed.private_key ?? "",
    projectId: parsed.project_id ?? null,
    iosAppId: r.metadata.iosAppId ? String(r.metadata.iosAppId) : null,
    androidAppId: r.metadata.androidAppId ? String(r.metadata.androidAppId) : null,
    testerGroups: Array.isArray(groups) ? groups.map(String) : [],
  };
}

export interface AppleStoreCredential {
  keyId: string;
  issuerId: string;
  p8: string;
}

/**
 * Loads the App Store Connect API key. Prefers the credential bound to the app
 * (App.credentialId) so a tenant with several keys always gets the right one;
 * falls back to the single active APPLE key. Deterministic (orderBy createdAt).
 */
export async function loadAppleCredential(
  credentialId?: string | null,
): Promise<AppleStoreCredential | null> {
  let cred = credentialId
    ? await prisma.credential.findFirst({ where: { id: credentialId, kind: "APPLE", isActive: true } })
    : null;
  if (!cred) {
    cred = await prisma.credential.findFirst({
      where: { kind: "APPLE", isActive: true },
      orderBy: { createdAt: "desc" },
    });
  }
  if (!cred) return null;
  const secret = await secretProvider.get(cred.secretRef);
  return { keyId: cred.appleKeyId ?? "", issuerId: cred.appleIssuerId ?? "", p8: secret.content };
}

export interface GoogleStoreCredential {
  clientEmail: string;
  privateKeyPem: string;
  projectId?: string;
}

/** Loads the tenant's Google Play service account (reuses the Credential table). */
export async function loadGoogleCredential(): Promise<GoogleStoreCredential | null> {
  const cred = await prisma.credential.findFirst({ where: { kind: "GOOGLE", isActive: true } });
  if (!cred) return null;
  const secret = await secretProvider.get(cred.secretRef);
  const parsed = JSON.parse(secret.content) as {
    client_email?: string;
    private_key?: string;
    project_id?: string;
  };
  return {
    clientEmail: parsed.client_email ?? "",
    privateKeyPem: parsed.private_key ?? "",
    projectId: parsed.project_id,
  };
}

export async function loadKeystoreConnection(appId: string): Promise<KeystoreConnection | null> {
  const r = await loadRaw(appId, "ANDROID_KEYSTORE");
  if (!r) return null;
  return {
    keystoreBytes: Buffer.from(r.content, "base64"),
    storePassword: r.secretMeta.storePassword ?? "",
    keyAlias: String(r.metadata.keyAlias ?? r.secretMeta.keyAlias ?? ""),
    keyPassword: r.secretMeta.keyPassword ?? r.secretMeta.storePassword ?? "",
    usePlayAppSigning: r.metadata.usePlayAppSigning === true,
  };
}
