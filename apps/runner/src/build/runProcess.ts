/**
 * Child-process runner with line streaming + cancellation.
 *
 * Every build shell command (git, gradle, flutter, pod, xcodebuild, apksigner,
 * firebase) goes through here so its output streams live to the Deploy tab and
 * a cancel kills the whole process group.
 */
import { spawn } from "node:child_process";

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Invoked for each non-empty stdout/stderr line. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** Killing this aborts the process group (cooperative cancel). */
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Secret strings to mask (→ `***`) in streamed lines AND in the failure
   * message/command echo. Defense-in-depth so a tool that echoes a password,
   * or a password that ends up in argv, never reaches the live log, the stored
   * `errorSummary`, the audit diff, or the AI build-diagnosis prompt.
   */
  redact?: string[];
}

/** Build a scrubber that replaces each non-empty secret with `***`. */
function makeScrubber(redact?: string[]): (s: string) => string {
  const secrets = (redact ?? []).filter((s) => s.length > 0);
  if (secrets.length === 0) return (s) => s;
  return (s) => {
    let out = s;
    for (const sec of secrets) out = out.split(sec).join("***");
    return out;
  };
}

export interface RunProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ProcessError extends Error {
  constructor(
    public readonly command: string,
    public readonly code: number | null,
    public readonly tail: string,
  ) {
    super(`Command failed (exit ${code ?? "null"}): ${command}\n${tail}`);
    this.name = "ProcessError";
  }
}

export function runProcess(
  command: string,
  args: string[],
  opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const scrub = makeScrubber(opts.redact);
  return new Promise((resolve, reject) => {
    // If the signal is ALREADY aborted, never spawn — otherwise an addEventListener
    // registered after the abort never fires and the process runs to completion.
    if (opts.signal?.aborted) {
      reject(new ProcessError(scrub(`${command} ${args.join(" ")}`), null, "cancelled"));
      return;
    }
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group → killable as a unit
    });

    let stdout = "";
    let stderr = "";
    const tail: string[] = [];
    const pushTail = (l: string): void => {
      tail.push(l);
      if (tail.length > 120) tail.shift();
    };

    let cancelled = false;
    const kill = (): void => {
      cancelled = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    opts.signal?.addEventListener("abort", kill, { once: true });
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;

    const consume = (buf: Buffer, stream: "stdout" | "stderr"): void => {
      const text = buf.toString();
      if (stream === "stdout") stdout += text;
      else stderr += text;
      for (const rawLine of text.split(/\r?\n/)) {
        if (rawLine.trim().length === 0) continue;
        const line = scrub(rawLine);
        pushTail(line);
        opts.onLine?.(line, stream);
      }
    };
    child.stdout.on("data", (b: Buffer) => consume(b, "stdout"));
    child.stderr.on("data", (b: Buffer) => consume(b, "stderr"));

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (cancelled) {
        reject(new ProcessError(scrub(`${command} ${args.join(" ")}`), code, "cancelled"));
        return;
      }
      if (code === 0) {
        resolve({ code: 0, stdout, stderr });
      } else {
        // tail lines are already scrubbed in consume(); scrub the command echo too.
        reject(new ProcessError(scrub(`${command} ${args.join(" ")}`), code, tail.join("\n")));
      }
    });
  });
}

/** Like runProcess but never rejects on non-zero — returns the result for
 *  probing (e.g. "is this tool installed?"). */
export async function tryProcess(
  command: string,
  args: string[],
  opts: RunProcessOptions = {},
): Promise<RunProcessResult | null> {
  try {
    return await runProcess(command, args, opts);
  } catch {
    return null;
  }
}
