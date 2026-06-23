import { z } from "zod";
import { Locale, Platform, Uuid } from "./common";

export const AppDto = z.object({
  id: Uuid,
  platform: Platform,
  bundleId: z.string(),
  storeAppId: z.string().nullable(),
  appName: z.string(),
  primaryLocale: Locale,
  status: z.string().nullable(),
  versionString: z.string().nullable(),
  versionId: z.string().nullable(),
  isConnected: z.boolean(),
  dirty: z.boolean(),
  availableLanguages: z.array(Locale),
  discoveredScreenshotTypes: z.array(z.string()),
  discoveredPreviewTypes: z.array(z.string()),
  lastFetchedAt: z.string().datetime().nullable(),
  lastPushedAt: z.string().datetime().nullable(),
  credentialId: Uuid,
  createdAt: z.string().datetime(),
});
export type AppDto = z.infer<typeof AppDto>;

export const CreateAppRequest = z.object({
  platform: Platform,
  bundleId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/, "Invalid bundle id"),
  appName: z.string().min(1).max(80),
  primaryLocale: Locale.default("en-US"),
  credentialId: Uuid,
});
export type CreateAppRequest = z.infer<typeof CreateAppRequest>;
