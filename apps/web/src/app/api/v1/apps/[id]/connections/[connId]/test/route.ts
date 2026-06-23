import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FirebaseAppDistribution,
  FirebaseClient,
  GoogleAuth,
} from "@marquee/core";
import { prisma } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

export const dynamic = "force-dynamic";

const pexec = promisify(execFile);

interface RouteContext {
  params: Promise<{ id: string; connId: string }>;
}

interface TestOutcome {
  ok: boolean;
  message: string;
  branchExists?: boolean;
  testerGroups?: { alias: string; displayName: string }[];
  aliasFound?: boolean;
}

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id: appId, connId } = await context.params;
  const sp = createSecretProvider();

  return withTenantContext(async () => {
    const conn = await prisma.appConnection.findFirst({ where: { id: connId, appId } });
    if (!conn) throw new NotFoundError("Connection not found");
    const secret = await sp.get(conn.secretRef);
    const meta = (conn.metadata as Record<string, unknown> | null) ?? {};

    let outcome: TestOutcome;
    if (conn.kind === "GIT") {
      outcome = await testGit(String(meta.repoUrl ?? ""), String(meta.branch ?? "main"), secret.content);
    } else if (conn.kind === "FIREBASE") {
      outcome = await testFirebase(secret.content, meta);
    } else {
      outcome = await testKeystore(secret.content, secret.metadata ?? {});
    }

    const now = new Date();
    await prisma.appConnection.update({
      where: { id: conn.id },
      data: { lastTestedAt: now, lastTestSucceeded: outcome.ok, lastTestMessage: outcome.message },
    });

    return NextResponse.json({
      ok: outcome.ok,
      message: outcome.message,
      testedAt: now.toISOString(),
      branchExists: outcome.branchExists,
      testerGroups: outcome.testerGroups,
      aliasFound: outcome.aliasFound,
    });
  });
});

async function testGit(repoUrl: string, branch: string, privateKeyPem: string): Promise<TestOutcome> {
  if (!repoUrl) return { ok: false, message: "No repository URL configured." };
  const keyFile = path.join(os.tmpdir(), `mq-testkey-${randomUUID()}`);
  await fs.writeFile(keyFile, privateKeyPem.endsWith("\n") ? privateKeyPem : `${privateKeyPem}\n`, {
    mode: 0o600,
  });
  try {
    const { stdout } = await pexec(
      "git",
      [
        // Disable git's command-executing transports for the stored repoUrl.
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "protocol.file.allow=user",
        "ls-remote",
        "--heads",
        "--",
        repoUrl,
      ],
      {
        timeout: 20_000,
        env: {
          ...process.env,
          GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    const branchExists = stdout.includes(`refs/heads/${branch}`);
    return {
      ok: true,
      message: branchExists
        ? `Clone verified — found branch "${branch}".`
        : `Clone verified, but branch "${branch}" was not found.`,
      branchExists,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const friendly = /permission denied|publickey/i.test(msg)
      ? "Permission denied — add the deploy key to the repository."
      : `Could not reach the repository: ${msg.split("\n")[0]}`;
    return { ok: false, message: friendly };
  } finally {
    await fs.rm(keyFile, { force: true }).catch(() => undefined);
  }
}

async function testFirebase(
  serviceAccountJson: string,
  meta: Record<string, unknown>,
): Promise<TestOutcome> {
  let parsed: { client_email?: string; private_key?: string; project_id?: string };
  try {
    parsed = JSON.parse(serviceAccountJson) as typeof parsed;
  } catch {
    return { ok: false, message: "Service-account JSON is not valid JSON." };
  }
  const cred = {
    id: "firebase-test",
    clientEmail: parsed.client_email ?? "",
    privateKeyPem: parsed.private_key ?? "",
    projectId: parsed.project_id,
  };
  const appId = (meta.androidAppId ?? meta.iosAppId) as string | undefined;
  const client = new FirebaseClient(new GoogleAuth(), cred);
  try {
    if (appId) {
      const fad = new FirebaseAppDistribution(client);
      const groups = await fad.listGroups(appId);
      return {
        ok: true,
        message: `Connected — ${groups.length.toString()} tester group(s) available.`,
        testerGroups: groups.map((g) => ({ alias: g.alias, displayName: g.displayName })),
      };
    }
    // No app id yet — just verify the token exchange works.
    await client.getToken();
    return { ok: true, message: "Connected. Add an app id to list tester groups." };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function testKeystore(
  keystoreBase64: string,
  secretMeta: Record<string, string>,
): Promise<TestOutcome> {
  const ksFile = path.join(os.tmpdir(), `mq-testks-${randomUUID()}.jks`);
  // Pass the store password via a 0600 file (keytool `:file` modifier), never
  // argv — execFile's failure message echoes the full command line, which used
  // to surface the password to the caller. Scrub it from any error too.
  const storePass = secretMeta.storePassword ?? "";
  const passFile = path.join(os.tmpdir(), `mq-testkspw-${randomUUID()}`);
  await fs.writeFile(ksFile, Buffer.from(keystoreBase64, "base64"), { mode: 0o600 });
  await fs.writeFile(passFile, storePass, { mode: 0o600 });
  const alias = secretMeta.keyAlias ?? "";
  const scrub = (s: string): string => (storePass ? s.split(storePass).join("***") : s);
  try {
    const { stdout } = await pexec(
      "keytool",
      ["-list", "-keystore", ksFile, "-storepass:file", passFile, "-alias", alias],
      { timeout: 15_000 },
    );
    const sha = /SHA256:\s*([0-9A-F:]+)/i.exec(stdout)?.[1];
    return {
      ok: true,
      message: `Keystore valid — alias "${alias}"${sha ? ` (SHA-256 ${sha.slice(0, 17)}…)` : ""}.`,
      aliasFound: true,
    };
  } catch (err: unknown) {
    const msg = scrub(err instanceof Error ? err.message : String(err));
    if (/ENOENT/.test(msg)) {
      return { ok: false, message: "keytool not available on the server to validate the keystore." };
    }
    return {
      ok: false,
      message: /password was incorrect|keystore password/i.test(msg)
        ? "Keystore or key password is incorrect."
        : `Could not read keystore: ${msg.split("\n")[0]}`,
      aliasFound: false,
    };
  } finally {
    await fs.rm(ksFile, { force: true }).catch(() => undefined);
    await fs.rm(passFile, { force: true }).catch(() => undefined);
  }
}
