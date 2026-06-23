/**
 * Tenant-scoped secret storage abstraction.
 *
 * Implementations:
 *   • FilesystemSecretProvider — dev / single-VM self-host
 *   • AwsSecretsManagerProvider — production SaaS (TODO V2)
 *   • VaultProvider — enterprise (TODO V2.5)
 *
 * Invariant: secretRef format `<scheme>:///tenants/<tenantId>/credentials/<credId>`
 * for every implementation. Routing happens via the scheme.
 */

export type SecretKind =
  | "APPLE"
  | "GOOGLE"
  | "APPLE_SEARCH_ADS"
  | "AI_ANTHROPIC"
  | "AI_OPENAI"
  | "AI_GEMINI"
  | "ASO_RESEARCH_MCP"
  // Build & Ship pipeline (Deploy tab) — per-app connection material.
  | "GIT_SSH"
  | "FIREBASE"
  | "ANDROID_KEYSTORE";

export interface SecretMaterial {
  kind: SecretKind;
  /**
   * For APPLE: contents of the .p8 file. For GOOGLE / FIREBASE: service-account
   * JSON string. For AI_*: the API key. For GIT_SSH: the PEM private deploy key.
   * For ANDROID_KEYSTORE: the keystore bytes, base64-encoded (passwords + alias
   * live in `metadata`).
   */
  content: string;
  /** Optional metadata stored alongside (key id, project id, model override, keystore passwords/alias, …). */
  metadata?: Record<string, string>;
}

export interface SecretProvider {
  /** Returns the canonical secretRef for the stored material. */
  put(tenantId: string, credentialId: string, material: SecretMaterial): Promise<string>;
  /** Reads the secret material by canonical reference. */
  get(secretRef: string): Promise<SecretMaterial>;
  /** Deletes the secret. Safe to call on missing refs. */
  delete(secretRef: string): Promise<void>;
  /** Lists secret refs for a tenant — for lifecycle cleanup. */
  listForTenant(tenantId: string): Promise<string[]>;
  /** Optional health check. */
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;
}
