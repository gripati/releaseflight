import { createPrivateKey, createSign } from "node:crypto";
import { base64UrlEncode } from "./base64url";
import { CredentialInvalidError } from "../errors";

export interface AppleJwtInput {
  keyId: string;
  issuerId: string;
  /** PEM-encoded EC private key (PKCS#8). Apple .p8 file content. */
  privateKeyPem: string;
  /** Token lifetime in seconds. Apple max = 1200 (20 min). */
  ttlSeconds?: number;
}

/**
 * Create an ES256-signed JWT for App Store Connect.
 *
 * Apple expects an ECDSA P-256 signature in IEEE-P1363 format (raw R||S,
 * 64 bytes). Node's createSign produces DER by default — we set
 * `dsaEncoding: 'ieee-p1363'` to get the raw format Apple requires.
 *
 * Reference: https://developer.apple.com/documentation/appstoreconnectapi/generating_tokens_for_api_requests
 */
export function createAppleEs256Jwt(input: AppleJwtInput): string {
  if (!input.keyId) throw new CredentialInvalidError("Apple keyId is required");
  if (!input.issuerId) throw new CredentialInvalidError("Apple issuerId is required");
  if (!input.privateKeyPem?.includes("BEGIN")) {
    throw new CredentialInvalidError("Apple privateKeyPem must be PEM-encoded");
  }

  const ttl = Math.min(input.ttlSeconds ?? 1200, 1200);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "ES256", kid: input.keyId, typ: "JWT" };
  const payload = {
    iss: input.issuerId,
    iat: now,
    exp: now + ttl,
    aud: "appstoreconnect-v1",
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  let keyObject;
  try {
    keyObject = createPrivateKey({ key: input.privateKeyPem, format: "pem" });
  } catch (cause: unknown) {
    throw new CredentialInvalidError("Failed to parse Apple private key (.p8)", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  if (keyObject.asymmetricKeyType !== "ec") {
    throw new CredentialInvalidError(
      `Apple private key must be ECDSA (got "${keyObject.asymmetricKeyType ?? "unknown"}")`,
    );
  }

  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: keyObject, dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${base64UrlEncode(signature)}`;
}
