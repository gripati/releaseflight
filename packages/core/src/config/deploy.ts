/**
 * Deployment mode configuration. The same binary runs in self-host and SaaS
 * mode; behaviour differs based on env. See docs/11_SELF_HOST_TO_SAAS.md.
 */

export type DeployMode = "self_host" | "saas";

export interface SelfHostConfig {
  ownerEmail: string;
  ownerPassword: string;
}

export interface SaasConfig {
  appUrl: string;
  marketingUrl: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  signupEnabled: boolean;
  requireEmailVerification: boolean;
  defaultTrialDays: number;
  resendApiKey?: string;
}

export interface DeployConfig {
  mode: DeployMode;
  appUrl: string;
  selfHost?: SelfHostConfig;
  saas?: SaasConfig;
}

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined || v === "") return def;
  return v === "true" || v === "1" || v === "yes";
}

function int(v: string | undefined, def: number): number {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : def;
}

function loadDeployConfig(): DeployConfig {
  const mode = (process.env.DEPLOY_MODE ?? "self_host") as DeployMode;
  if (mode !== "self_host" && mode !== "saas") {
    throw new Error(`Invalid DEPLOY_MODE: "${mode}" (must be "self_host" or "saas")`);
  }
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  const base: DeployConfig = { mode, appUrl };

  if (mode === "self_host") {
    base.selfHost = {
      ownerEmail: process.env.SELF_HOST_OWNER_EMAIL ?? "owner@example.com",
      ownerPassword: process.env.SELF_HOST_OWNER_PASSWORD ?? "",
    };
  } else {
    base.saas = {
      appUrl,
      marketingUrl: process.env.SAAS_MARKETING_URL ?? appUrl,
      stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
      signupEnabled: bool(process.env.SAAS_SIGNUP_ENABLED, true),
      requireEmailVerification: bool(process.env.SAAS_REQUIRE_EMAIL_VERIFICATION, true),
      defaultTrialDays: int(process.env.SAAS_DEFAULT_TRIAL_DAYS, 14),
      resendApiKey: process.env.RESEND_API_KEY,
    };
  }

  return base;
}

// Lazy singleton — process-wide
let _config: DeployConfig | undefined;

export function getDeployConfig(): DeployConfig {
  if (!_config) _config = loadDeployConfig();
  return _config;
}

export function isSelfHost(): boolean {
  return getDeployConfig().mode === "self_host";
}

export function isSaas(): boolean {
  return getDeployConfig().mode === "saas";
}

/** Reset config — only used in tests. */
export function _resetDeployConfigForTesting(): void {
  _config = undefined;
}
