/**
 * Generates an ed25519 SSH deploy keypair via ssh-keygen. The private key is
 * stored in the secret store; the public key is shown to the user to paste
 * into GitHub/GitLab "Deploy keys". Shelling out to ssh-keygen yields proper
 * OpenSSH-format keys (Node's crypto only emits PKCS8/SPKI PEM).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const pexec = promisify(execFile);

export async function generateDeployKey(
  comment: string,
): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mq-key-"));
  const keyPath = path.join(dir, "id_ed25519");
  try {
    await pexec("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath], {
      timeout: 10_000,
    });
    const [privateKey, publicKey] = await Promise.all([
      fs.readFile(keyPath, "utf8"),
      fs.readFile(`${keyPath}.pub`, "utf8"),
    ]);
    return { privateKey, publicKey: publicKey.trim() };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
