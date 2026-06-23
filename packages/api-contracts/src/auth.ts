import { z } from "zod";
import { Email, TenantSlug } from "./common";

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(8).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  ok: z.literal(true),
  redirectTo: z.string(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const MeResponse = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  activeTenant: z
    .object({
      id: z.string().uuid(),
      slug: TenantSlug,
      name: z.string(),
      role: z.enum(["OWNER", "ADMIN", "MAINTAINER", "EDITOR", "VIEWER"]),
    })
    .nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const SignupRequest = z.object({
  email: Email,
  password: z.string().min(12).max(256),
  displayName: z.string().min(1).max(64),
  tenantName: z.string().min(1).max(64),
  tenantSlug: TenantSlug,
  captchaToken: z.string().optional(),
});
export type SignupRequest = z.infer<typeof SignupRequest>;
