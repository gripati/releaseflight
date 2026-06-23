/**
 * gitClone transport safety — pins MARQ-006/031: the runner must refuse a
 * command-executing git transport (`ext::`/`fd::`) or option-injection in the
 * repoUrl/ref BEFORE spawning git. These guards throw early, so the tests need
 * no git binary and never hit the network.
 */
import { describe, test, expect } from "vitest";
import { gitClone } from "../git";

const DEST = "/tmp/mq-test-clone-should-never-be-created";

describe("gitClone — transport safety (MARQ-006/031)", () => {
  test("rejects an ext:: command transport", async () => {
    await expect(
      gitClone({ repoUrl: "ext::sh -c id", ref: "main", dest: DEST }),
    ).rejects.toThrow(/unsafe repository/i);
  });

  test("rejects any repoUrl containing ::", async () => {
    await expect(
      gitClone({ repoUrl: "fd::17/foo", ref: "main", dest: DEST }),
    ).rejects.toThrow(/unsafe repository/i);
  });

  test("rejects a repoUrl that starts with - (option injection)", async () => {
    await expect(
      gitClone({ repoUrl: "-oProxyCommand=evil", ref: "main", dest: DEST }),
    ).rejects.toThrow(/unsafe repository/i);
  });

  test("rejects a ref that starts with -", async () => {
    await expect(
      gitClone({ repoUrl: "https://github.com/x/y.git", ref: "-x", dest: DEST }),
    ).rejects.toThrow(/unsafe git ref/i);
  });

  test("rejects a ref containing spaces", async () => {
    await expect(
      gitClone({ repoUrl: "https://github.com/x/y.git", ref: "a b", dest: DEST }),
    ).rejects.toThrow(/unsafe git ref/i);
  });
});
