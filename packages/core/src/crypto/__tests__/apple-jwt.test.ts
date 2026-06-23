import { describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createAppleEs256Jwt } from "../apple-jwt";
import { CredentialInvalidError } from "../../errors";
import { base64UrlDecode } from "../base64url";

function generateEcPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

function generateRsaPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

describe("createAppleEs256Jwt", () => {
  test("produces a 3-segment JWT with ES256 header", () => {
    const jwt = createAppleEs256Jwt({
      keyId: "ABC123DEF4",
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      privateKeyPem: generateEcPem(),
    });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(base64UrlDecode(parts[0]!).toString()) as {
      alg: string;
      kid: string;
      typ: string;
    };
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("ABC123DEF4");
    expect(header.typ).toBe("JWT");

    const payload = JSON.parse(base64UrlDecode(parts[1]!).toString()) as {
      iss: string;
      aud: string;
      iat: number;
      exp: number;
    };
    expect(payload.iss).toBe("57246542-96fe-1a63-e053-0824d011072a");
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(payload.exp - payload.iat).toBe(1200);
  });

  test("rejects non-EC private key with CredentialInvalidError", () => {
    expect(() =>
      createAppleEs256Jwt({
        keyId: "ABC123",
        issuerId: "57246542-96fe-1a63-e053-0824d011072a",
        privateKeyPem: generateRsaPem(),
      }),
    ).toThrowError(CredentialInvalidError);
  });

  test("rejects empty keyId / issuerId", () => {
    expect(() =>
      createAppleEs256Jwt({ keyId: "", issuerId: "x", privateKeyPem: generateEcPem() }),
    ).toThrow();
  });

  test("ttl is capped at 1200s", () => {
    const jwt = createAppleEs256Jwt({
      keyId: "X",
      issuerId: "y",
      privateKeyPem: generateEcPem(),
      ttlSeconds: 5000,
    });
    const payload = JSON.parse(base64UrlDecode(jwt.split(".")[1]!).toString()) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(1200);
  });

  test("signature is 64 bytes (P1363 raw, not DER) — Apple requirement", () => {
    const jwt = createAppleEs256Jwt({
      keyId: "X",
      issuerId: "y",
      privateKeyPem: generateEcPem(),
    });
    const sig = base64UrlDecode(jwt.split(".")[2]!);
    expect(sig.byteLength).toBe(64);
  });
});
