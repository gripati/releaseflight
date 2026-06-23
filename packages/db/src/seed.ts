/**
 * Self-host bootstrap seed. Idempotent.
 *
 * Creates a single tenant "default" and a single OWNER user from env vars:
 *   SELF_HOST_OWNER_EMAIL
 *   SELF_HOST_OWNER_PASSWORD
 *
 * Safe to run on every boot. In SaaS mode the seed is a no-op.
 */
import argon2 from "argon2";
import { prismaUnscoped } from "./prisma";

const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "00000000-0000-4000-8000-000000000002";

async function main(): Promise<void> {
  const deployMode = process.env.DEPLOY_MODE ?? "self_host";
  if (deployMode !== "self_host") {
    console.log(`Seed skipped (DEPLOY_MODE=${deployMode}).`);
    return;
  }

  const email = process.env.SELF_HOST_OWNER_EMAIL;
  const password = process.env.SELF_HOST_OWNER_PASSWORD;
  if (!email || !password) {
    console.error("Seed aborted: SELF_HOST_OWNER_EMAIL and SELF_HOST_OWNER_PASSWORD are required.");
    process.exitCode = 1;
    return;
  }

  console.log("Seeding self-host defaults …");

  // 1. Tenant
  const tenant = await prismaUnscoped.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    create: {
      id: DEFAULT_TENANT_ID,
      slug: "default",
      name: "My Studio",
      deployedAs: "SELF_HOST",
      status: "ACTIVE",
      planTier: "ENTERPRISE",
      maxApps: 9999,
      maxMembers: 9999,
      maxPushesPerMonth: 999999,
    },
    update: {
      deployedAs: "SELF_HOST",
      planTier: "ENTERPRISE",
    },
  });
  console.log(`  • tenant: ${tenant.slug} (${tenant.id})`);

  // 2. Owner user
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const user = await prismaUnscoped.user.upsert({
    where: { email },
    create: {
      id: OWNER_USER_ID,
      email,
      passwordHash,
      displayName: email.split("@")[0] ?? "Owner",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      defaultTenantId: tenant.id,
      // The operator chose this password via env — no forced first-login change
      // for the bootstrap owner (that flag is only for members an admin
      // provisions later through the "Add member" flow).
      mustChangePassword: false,
    },
    update: {
      // Only update password on every boot if env says so explicitly
    },
  });
  console.log(`  • owner: ${user.email}`);

  // 3. Membership
  await prismaUnscoped.tenantMember.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
    create: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
    update: { role: "OWNER" },
  });
  console.log("  • membership: OWNER");

  // 4. Runtime DB role password (self-host dev).
  // The app RUNTIME connects as the non-bypass `gp_app` role so Row-Level
  // Security is enforced. rls.sql creates that role WITHOUT a password (prod
  // sets it via a secret manager). For a one-command self-host bring-up we set
  // the dev password here so `db:reset` yields a working, RLS-enforced system
  // with no manual step. The seed runs as the bypass/admin role, which can
  // ALTER ROLE. This block never runs outside self-host (guarded above).
  const appRolePassword = process.env.GP_APP_DB_PASSWORD ?? "gp_app_dev_password";
  try {
    await prismaUnscoped.$executeRawUnsafe(
      `ALTER ROLE gp_app WITH PASSWORD '${appRolePassword.replace(/'/g, "''")}'`,
    );
    console.log("  • gp_app runtime role password set");
  } catch {
    // gp_app may not exist yet if db:rls hasn't been applied — non-fatal.
    console.warn("  • gp_app role not found (run db:rls first); skipped password set");
  }

  console.log("Seed completed.");
}

void main()
  .catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaUnscoped.$disconnect();
  });
