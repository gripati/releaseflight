import { describe, expect, test } from "vitest";
import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import { createGoogleServiceAccountJwt } from "../google-jwt";
import { base64UrlDecode } from "../base64url";

function generateRsaPem(): { privateKeyPem: string; publicKey: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey,
  };
}

describe("createGoogleServiceAccountJwt", () => {
  test("produces verifiable RS256 JWT", () => {
    const { privateKeyPem, publicKey } = generateRsaPem();
    const jwt = createGoogleServiceAccountJwt({
      clientEmail: "svc@my-project.iam.gserviceaccount.com",
      privateKeyPem,
      scope: "https://www.googleapis.com/auth/androidpublisher",
    });
    const [hB64, pB64, sigB64] = jwt.split(".");

    const verify = createVerify("RSA-SHA256");
    verify.update(`${hB64!}.${pB64!}`);
    verify.end();
    expect(verify.verify(publicKey, base64UrlDecode(sigB64!))).toBe(true);

    const payload = JSON.parse(base64UrlDecode(pB64!).toString()) as {
      iss: string;
      scope: string;
      aud: string;
    };
    expect(payload.iss).toBe("svc@my-project.iam.gserviceaccount.com");
    expect(payload.scope).toBe("https://www.googleapis.com/auth/androidpublisher");
    expect(payload.aud).toBe("https://oauth2.googleapis.com/token");
  });
});
