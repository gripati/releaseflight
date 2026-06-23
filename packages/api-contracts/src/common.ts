import { z } from "zod";

export const Uuid = z.string().uuid();
export const Email = z.string().email();
export const Locale = z.string().regex(/^[a-z]{2,3}(-[A-Z][A-Za-z0-9]+)?$/, "Invalid locale");
export const TenantSlug = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, digits and dashes only");

export const Platform = z.enum(["IOS", "ANDROID"]);
export type Platform = z.infer<typeof Platform>;

export const TenantRole = z.enum(["OWNER", "ADMIN", "MAINTAINER", "EDITOR", "VIEWER"]);
export type TenantRole = z.infer<typeof TenantRole>;

export const ApiErrorCode = z.enum([
  "VALIDATION_ERROR",
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "UPSTREAM_TIMEOUT",
  "CREDENTIAL_INVALID",
  "CREDENTIAL_EXPIRED",
  "INTERNAL_ERROR",
  "UNSUPPORTED_LOCALE",
  "FILE_TOO_LARGE",
  "INVALID_DIMENSIONS",
  "DIRTY_OVERWRITE_BLOCKED",
  "TENANT_LIMIT_EXCEEDED",
  "TENANT_SUSPENDED",
]);

export const ApiError = z.object({
  code: ApiErrorCode,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  requestId: z.string().optional(),
});

export type ApiError = z.infer<typeof ApiError>;

export const ApiErrorResponse = z.object({ error: ApiError });
export type ApiErrorResponse = z.infer<typeof ApiErrorResponse>;
