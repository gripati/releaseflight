import { createPrivateKey, createSign } from "node:crypto";
import { base64UrlEncode } from "./base64url";
import { CredentialInvalidError } from "../errors";

export interface GoogleJwtInput {
  clientEmail: string;
  /** PEM-encoded RSA private key. From service account JSON `private_key`. */
  privateKeyPem: string;
  /** Space-separated scopes. */
  scope: string;
  /** Token URL (audience). Default: oauth2.googleapis.com/token. */
  audience?: string;
  /** Lifetime in seconds. Google max = 3600. */
  ttlSeconds?: number;
}

const DEFAULT_AUDIENCE = "https://oauth2.googleapis.com/token";

/**
 * Create an RS256-signed JWT for Google service-account auth flow.
 * The returned JWT must be exchanged for an access_token via the
 * grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer flow.
 *
 * Reference: https://developers.google.com/identity/protocols/oauth2/service-account
 */
export function createGoogleServiceAccountJwt(input: GoogleJwtInput): string {
  if (!input.clientEmail) throw new CredentialInvalidError("Google clientEmail is required");
  if (!input.privateKeyPem?.includes("BEGIN")) {
    throw new CredentialInvalidError("Google privateKeyPem must be PEM-encoded");
  }
  if (!input.scope) throw new CredentialInvalidError("Google scope is required");

  const ttl = Math.min(input.ttlSeconds ?? 3600, 3600);
  const audience = input.audience ?? DEFAULT_AUDIENCE;
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: input.clientEmail,
    scope: input.scope,
    aud: audience,
    iat: now,
    exp: now + ttl,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  let keyObject;
  try {
    keyObject = createPrivateKey({ key: input.privateKeyPem, format: "pem" });
  } catch (cause: unknown) {
    throw new CredentialInvalidError("Failed to parse Google service-account private key", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  if (keyObject.asymmetricKeyType !== "rsa") {
    throw new CredentialInvalidError(
      `Google service-account private key must be RSA (got "${keyObject.asymmetricKeyType ?? "unknown"}")`,
    );
  }

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(keyObject);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}
