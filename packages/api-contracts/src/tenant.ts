import { z } from "zod";
import { Email, TenantRole, TenantSlug, Uuid } from "./common";

export const TenantDto = z.object({
  id: Uuid,
  slug: TenantSlug,
  name: z.string(),
  status: z.enum(["ACTIVE", "SUSPENDED", "PENDING_DELETE"]),
  deployedAs: z.enum(["SELF_HOST", "SAAS"]),
  planTier: z.enum(["FREE", "PRO", "TEAM", "ENTERPRISE"]),
  trialEndsAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  memberCount: z.number().int().nonnegative(),
  appCount: z.number().int().nonnegative(),
});
export type TenantDto = z.infer<typeof TenantDto>;

export const TenantMemberDto = z.object({
  userId: Uuid,
  email: Email,
  displayName: z.string(),
  role: TenantRole,
  joinedAt: z.string().datetime(),
  lastActiveAt: z.string().datetime().nullable(),
});
export type TenantMemberDto = z.infer<typeof TenantMemberDto>;

export const CreateMemberRequest = z.object({
  email: Email,
  displayName: z.string().min(1).max(64),
  password: z.string().min(12).max(256).optional(),
  role: TenantRole,
  allowedAppIds: z.array(Uuid).max(1000).default([]),
});
export type CreateMemberRequest = z.infer<typeof CreateMemberRequest>;

export const SwitchTenantRequest = z.object({ tenantId: Uuid });
