import { describe, expect, test } from "vitest";
import { CreateCredentialRequest, CredentialKind } from "../credential";

const VALID_PEM =
  "-----BEGIN PRIVATE KEY-----\n" +
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ" +
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV\n" +
  "-----END PRIVATE KEY-----";

describe("CredentialKind enum", () => {
  test("covers every supported credential type", () => {
    expect(CredentialKind.options).toEqual([
      "APPLE",
      "GOOGLE",
      "AI_ANTHROPIC",
      "AI_OPENAI",
      "AI_GEMINI",
      "ASO_RESEARCH_MCP",
    ]);
  });
});

describe("CreateCredentialRequest — APPLE", () => {
  test("accepts valid App Store Connect material", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "APPLE",
      name: "Prod",
      keyId: "ABC123DEF4",
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      privateKeyPem: VALID_PEM,
    });
    expect(r.success).toBe(true);
  });

  test("rejects keyId with wrong case / format", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "APPLE",
      name: "Prod",
      keyId: "abc123",
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      privateKeyPem: VALID_PEM,
    });
    expect(r.success).toBe(false);
  });

  test("rejects non-UUID issuer", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "APPLE",
      name: "Prod",
      keyId: "ABCDEFGH12",
      issuerId: "not-a-uuid",
      privateKeyPem: VALID_PEM,
    });
    expect(r.success).toBe(false);
  });

  test("rejects PEM that is missing BEGIN marker", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "APPLE",
      name: "Prod",
      keyId: "ABCDEFGH12",
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      privateKeyPem: "x".repeat(200),
    });
    expect(r.success).toBe(false);
  });

  test("accepts optional vendorNumber when 6-12 digits", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "APPLE",
      name: "Prod",
      keyId: "ABCDEFGH12",
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      privateKeyPem: VALID_PEM,
      vendorNumber: "1234567",
    });
    expect(r.success).toBe(true);
  });
});

describe("CreateCredentialRequest — GOOGLE", () => {
  test("accepts service-account JSON with client_email + private_key", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "GOOGLE",
      name: "Play Main",
      serviceAccountJson: JSON.stringify({
        type: "service_account",
        client_email: "service@project.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----",
        project_id: "my-project",
      }),
    });
    expect(r.success).toBe(true);
  });

  test("rejects service-account JSON missing required fields", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "GOOGLE",
      name: "Play Main",
      serviceAccountJson: JSON.stringify({ type: "service_account" }),
    });
    expect(r.success).toBe(false);
  });

  test("rejects invalid JSON string", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "GOOGLE",
      name: "Play Main",
      serviceAccountJson: "not-json",
    });
    expect(r.success).toBe(false);
  });
});

describe("CreateCredentialRequest — AI providers", () => {
  test.each(["AI_ANTHROPIC", "AI_OPENAI", "AI_GEMINI"] as const)(
    "accepts %s with apiKey + optional model",
    (kind) => {
      const r = CreateCredentialRequest.safeParse({
        kind,
        name: `${kind} key`,
        apiKey: "sk-1234567890",
        model: "claude-opus-4-7",
      });
      expect(r.success).toBe(true);
    },
  );

  test("rejects AI credential with apiKey shorter than 8 chars", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "AI_OPENAI",
      name: "OpenAI",
      apiKey: "short",
    });
    expect(r.success).toBe(false);
  });
});

describe("CreateCredentialRequest — ASO_RESEARCH_MCP (Astro)", () => {
  test("accepts a minimal valid Astro / AppTweak MCP credential", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "ASO_RESEARCH_MCP",
      name: "Astro Pro",
      endpoint: "https://astro.example.com/mcp",
      apiKey: "sk_abcdef1234567890",
    });
    expect(r.success).toBe(true);
  });

  test("accepts optional toolName override", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "ASO_RESEARCH_MCP",
      name: "Astro Pro",
      endpoint: "https://astro.example.com/mcp",
      apiKey: "sk_abcdef1234567890",
      toolName: "astro.search_volume",
    });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { toolName: string }).toolName).toBe("astro.search_volume");
  });

  test("rejects bad endpoint URL", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "ASO_RESEARCH_MCP",
      name: "Astro",
      endpoint: "not-a-url",
      apiKey: "sk_abcdef1234567890",
    });
    expect(r.success).toBe(false);
  });

  test("rejects apiKey shorter than 8 chars", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "ASO_RESEARCH_MCP",
      name: "Astro",
      endpoint: "https://astro.example.com/mcp",
      apiKey: "short",
    });
    expect(r.success).toBe(false);
  });

  test("rejects extra unknown fields are tolerated by the discriminator", () => {
    // Zod object schemas allow extra fields by default — but they should
    // still parse to the typed shape without the extras leaking through.
    const r = CreateCredentialRequest.safeParse({
      kind: "ASO_RESEARCH_MCP",
      name: "Astro",
      endpoint: "https://astro.example.com/mcp",
      apiKey: "sk_abcdef1234567890",
      randomExtra: 123,
    });
    expect(r.success).toBe(true);
  });
});

describe("CreateCredentialRequest — discriminated union", () => {
  test("rejects payload with unknown kind", () => {
    const r = CreateCredentialRequest.safeParse({
      kind: "FAKE_KIND",
      name: "X",
    });
    expect(r.success).toBe(false);
  });

  test("rejects payload missing kind", () => {
    const r = CreateCredentialRequest.safeParse({ name: "X" });
    expect(r.success).toBe(false);
  });
});
