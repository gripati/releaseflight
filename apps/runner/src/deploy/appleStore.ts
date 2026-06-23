/**
 * Apple App Store Connect upload (TestFlight / App Store) via xcrun altool.
 *
 * altool resolves the API key from a `private_keys/AuthKey_<keyId>.p8` folder.
 * It searches `./private_keys` (relative to the working directory) BEFORE the
 * shared `~/.appstoreconnect/private_keys`, so we stage the key in a per-build
 * 0700 temp dir and run altool with that cwd — the key never lands in the
 * shared, predictably-named home location where a later build for another
 * tenant could read it if a crash skipped cleanup. macOS only.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, ProcessError } from "../build/runProcess";
import type { AppleAuthKey } from "../build/ios/buildIos";

export async function uploadToAppStore(ctx: {
  ipaPath: string;
  apple: AppleAuthKey;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<{ uploaded: boolean; alreadyUploaded?: boolean }> {
  // Per-build private staging dir: <tmp>/mq-asc-XXXX/private_keys/AuthKey_<id>.p8
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "mq-asc-"));
  const keyDir = path.join(stageDir, "private_keys");
  await fs.mkdir(keyDir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(keyDir, `AuthKey_${ctx.apple.keyId}.p8`);
  const p8 = await fs.readFile(ctx.apple.p8Path, "utf8");
  await fs.writeFile(keyFile, p8, { mode: 0o600 });

  try {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await runProcess(
          "xcrun",
          [
            "altool",
            "--upload-app",
            "--type",
            "ios",
            "--file",
            ctx.ipaPath,
            "--apiKey",
            ctx.apple.keyId,
            "--apiIssuer",
            ctx.apple.issuerId,
            "--output-format",
            "xml",
          ],
          { cwd: stageDir, onLine: ctx.onLine, signal: ctx.signal, timeoutMs: 60 * 60_000 },
        );
        return { uploaded: true };
      } catch (err) {
        const tail = err instanceof ProcessError ? err.tail : String(err);
        if (/already.*uploaded|redundant binary/i.test(tail)) {
          return { uploaded: true, alreadyUploaded: true };
        }
        if (attempt === maxAttempts) throw err;
        ctx.onLine?.(`altool attempt ${attempt.toString()} failed — retrying in 30s…`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
    return { uploaded: false };
  } finally {
    // Remove the whole staging dir (key + parent), not just the file.
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
