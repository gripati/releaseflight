/**
 * Shallow git clone with an optional per-build SSH deploy key.
 *
 * The private key is written to a 0600 temp file, used via GIT_SSH_COMMAND,
 * and removed in a finally — it never persists past the clone.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./runProcess";

export async function gitClone(opts: {
  repoUrl: string;
  ref: string;
  dest: string;
  privateKeyPem?: string | null;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<{ commitSha: string }> {
  // Defense-in-depth against a malicious `repoUrl`/`ref` even though the API
  // contract validates them: refuse git's command-executing transports
  // (`ext::sh -c …`, `fd::`) and option-injection (a leading `-` that git would
  // read as a flag). The `-c protocol.*.allow` flags below are the real backstop.
  if (opts.repoUrl.includes("::") || /^\s*-/.test(opts.repoUrl)) {
    throw new Error("Refusing to clone an unsafe repository URL");
  }
  if (/^\s*-/.test(opts.ref) || opts.ref.includes(" ")) {
    throw new Error("Refusing to clone an unsafe git ref");
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  let keyFile: string | null = null;

  try {
    if (opts.privateKeyPem) {
      keyFile = path.join(os.tmpdir(), `mq-deploykey-${randomUUID()}`);
      const pem = opts.privateKeyPem.endsWith("\n") ? opts.privateKeyPem : `${opts.privateKeyPem}\n`;
      await fs.writeFile(keyFile, pem, { mode: 0o600 });
      env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    }

    await runProcess(
      "git",
      [
        // Disable the `ext::`/`file://` transports that can run arbitrary
        // commands during clone. Must precede the `clone` subcommand.
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "protocol.file.allow=user",
        "clone",
        "--depth",
        "1",
        "--branch",
        opts.ref,
        "--single-branch",
        "--",
        opts.repoUrl,
        opts.dest,
      ],
      { env, onLine: (l) => opts.onLine?.(l), signal: opts.signal, timeoutMs: 10 * 60_000 },
    );

    const rev = await runProcess("git", ["-C", opts.dest, "rev-parse", "HEAD"], { env });
    return { commitSha: rev.stdout.trim() };
  } finally {
    if (keyFile) await fs.rm(keyFile, { force: true }).catch(() => undefined);
  }
}
