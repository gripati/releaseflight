/**
 * Toolchain probe — detects which build tools are installed on this runner
 * and their versions. Reported into the `Runner.toolchain` heartbeat so the
 * web UI can show "macOS runner online, Xcode 16.2" and gate iOS builds.
 *
 * Phase 4 extends this into auto-install (DependencyManager.cs parity).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

async function ver(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, { timeout: 8000 });
    // Some tools (java) print their version banner to stderr.
    const out = (stdout || stderr || "").trim();
    return out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

export interface Toolchain {
  node: string | null;
  xcodebuild: string | null;
  flutter: string | null;
  firebaseCli: string | null;
  cocoapods: string | null;
  java: string | null;
}

export async function probeToolchain(): Promise<Toolchain> {
  const [node, xcodebuild, flutter, firebaseCli, cocoapods, java] = await Promise.all([
    ver("node", ["--version"]),
    ver("xcodebuild", ["-version"]),
    ver("flutter", ["--version"]),
    ver("firebase", ["--version"]),
    ver("pod", ["--version"]),
    ver("java", ["-version"]),
  ]);
  return { node, xcodebuild, flutter, firebaseCli, cocoapods, java };
}
