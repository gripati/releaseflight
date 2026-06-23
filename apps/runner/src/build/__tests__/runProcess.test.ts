/**
 * runProcess redaction — pins MARQ-004/007/014: secrets passed via `redact`
 * must never reach the streamed log, the ProcessError message, or (downstream)
 * the build errorSummary / audit diff / AI-diagnosis prompt.
 *
 * Uses `node -e` as a controllable child process (always on PATH).
 */
import { describe, test, expect } from "vitest";
import { runProcess, ProcessError } from "../runProcess";

describe("runProcess — redact (MARQ-004/007/014)", () => {
  test("scrubs a redacted secret from the failure message + command echo", async () => {
    const secret = "S3cr3t-Keystore-Pass";
    let caught: unknown;
    try {
      await runProcess(
        "node",
        ["-e", `console.error('storepass=${secret}'); process.exit(1)`],
        { redact: [secret] },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProcessError);
    const msg = (caught as Error).message;
    expect(msg).not.toContain(secret);
    expect(msg).toContain("***");
  });

  test("scrubs the secret from streamed onLine output", async () => {
    const secret = "another-secret-value-xyz";
    const lines: string[] = [];
    await runProcess("node", ["-e", `console.log('pw=${secret}')`], {
      redact: [secret],
      onLine: (l) => lines.push(l),
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain(secret);
    expect(joined).toContain("***");
  });

  test("does not alter output when no redact list is given", async () => {
    const lines: string[] = [];
    await runProcess("node", ["-e", `console.log('hello-plain-output')`], {
      onLine: (l) => lines.push(l),
    });
    expect(lines.join("\n")).toContain("hello-plain-output");
  });

  test("resolves with stdout on success (exit 0)", async () => {
    const res = await runProcess("node", ["-e", `process.stdout.write('ok-result')`], {});
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("ok-result");
  });
});
