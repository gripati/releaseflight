import { z } from "zod";
import { Uuid } from "./common";

export const CredentialKind = z.enum([
  "APPLE",
  "GOOGLE",
  "AI_ANTHROPIC",
  "AI_OPENAI",
  "AI_GEMINI",
  "ASO_RESEARCH_MCP",
]);
export type CredentialKind = z.infer<typeof CredentialKind>;

export const CredentialDto = z.object({
  id: Uuid,
  kind: CredentialKind,
  name: z.string(),
  appleKeyId: z.string().nullable(),
  appleIssuerId: z.string().nullable(),
  googleClientEmail: z.string().nullable(),
  googleProjectId: z.string().nullable(),
  lastTestedAt: z.string().datetime().nullable(),
  lastTestSucceeded: z.boolean().nullable(),
  lastTestMessage: z.string().nullable(),
  appCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  rotatedAt: z.string().datetime().nullable(),
  isActive: z.boolean(),
});
export type CredentialDto = z.infer<typeof CredentialDto>;

const AppleCredentialMaterial = z.object({
  kind: z.literal("APPLE"),
  name: z.string().min(1).max(80),
  keyId: z.string().regex(/^[A-Z0-9]{8,20}$/, "Apple Key ID format invalid"),
  issuerId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Issuer ID must be UUID"),
  privateKeyPem: z.string().min(100).refine((s) => s.includes("BEGIN"), "Must be PEM-encoded"),
  /** Optional but recommended: enables Sales and Trends Reports pull. */
  vendorNumber: z
    .string()
    .regex(/^\d{6,12}$/, "Vendor number must be 6-12 digits")
    .optional(),
});

const GoogleCredentialMaterial = z.object({
  kind: z.literal("GOOGLE"),
  name: z.string().min(1).max(80),
  serviceAccountJson: z.string().refine((s) => {
    try {
      const parsed = JSON.parse(s) as { client_email?: string; private_key?: string };
      return Boolean(parsed.client_email && parsed.private_key);
    } catch {
      return false;
    }
  }, "Invalid Google service-account JSON"),
});

const AiCredentialMaterial = z.object({
  kind: z.enum(["AI_ANTHROPIC", "AI_OPENAI", "AI_GEMINI"]),
  name: z.string().min(1).max(80),
  /** API key — `sk-...` for OpenAI, `sk-ant-...` for Anthropic, etc. */
  apiKey: z.string().min(8).max(400),
  /** Optional model override — e.g. "gpt-4o", "claude-opus-4-7", "gemini-1.5-pro" */
  model: z.string().min(1).max(80).optional(),
});

/**
 * Third-party ASO research provider over an MCP-style HTTP endpoint.
 * Same kind covers Astro / AppTweak / Sensor Tower / etc. because they
 * all expose a JSON-RPC-shaped HTTP endpoint we treat as a black box.
 */
const AsoResearchMcpCredentialMaterial = z.object({
  kind: z.literal("ASO_RESEARCH_MCP"),
  name: z.string().min(1).max(80),
  /** Full URL to the MCP HTTP endpoint. For Astro Desktop running
   *  locally this is `http://127.0.0.1:8089/mcp` (default port 8089).
   *  Scheme is restricted to http/https here; the server additionally applies
   *  an SSRF guard (assertSafeOutboundUrl) before fetching, blocking
   *  cloud-metadata / link-local / private targets at request time. */
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine(
      (s) => /^https?:\/\//i.test(s),
      "Endpoint must be an http(s) URL.",
    ),
  /** Bearer token sent as `Authorization: Bearer <apiKey>`. OPTIONAL —
   *  Astro Desktop doesn't require auth on localhost (rate limit only).
   *  Hosted AppTweak / Sensor Tower MCPs DO require a token. */
  apiKey: z.string().min(8).max(400).optional(),
  /** Optional MCP tool name override. Ignored for real Astro — the
   *  client uses Astro's documented tool names automatically. Kept for
   *  AppTweak / custom servers that expose a single bulk-lookup tool. */
  toolName: z.string().min(1).max(120).optional(),
});

export const CreateCredentialRequest = z.discriminatedUnion("kind", [
  AppleCredentialMaterial,
  GoogleCredentialMaterial,
  AsoResearchMcpCredentialMaterial,
  AiCredentialMaterial.extend({ kind: z.literal("AI_ANTHROPIC") }),
  AiCredentialMaterial.extend({ kind: z.literal("AI_OPENAI") }),
  AiCredentialMaterial.extend({ kind: z.literal("AI_GEMINI") }),
]);
export type CreateCredentialRequest = z.infer<typeof CreateCredentialRequest>;

export const TestConnectionResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  testedAt: z.string().datetime(),
});
export type TestConnectionResponse = z.infer<typeof TestConnectionResponse>;
