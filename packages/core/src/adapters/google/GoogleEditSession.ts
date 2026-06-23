import { UpstreamError } from "../../errors";
import type { GoogleClient } from "./GoogleClient";

export type CommitStrategy =
  | "managed_publishing"
  | "simple"
  | "draft_autosave"
  | "auto_review";

export interface CommitResult {
  ok: boolean;
  strategy: CommitStrategy | null;
  message: string;
}

/**
 * Google Play edit-session lifecycle with the four-strategy smart-commit
 * pipeline. Most edits should go through `withEdit(packageName, fn)`
 * which guarantees the edit is either committed or discarded.
 *
 *   Strategy precedence on commit attempt:
 *     1. managed_publishing  → POST :commit?changesNotSentForReview=true
 *     2. simple              → POST :commit
 *     3. draft_autosave      → "Only releases with status draft" — actual SUCCESS
 *     4. auto_review         → fall back to simple commit
 */
export class GoogleEditSession {
  constructor(private readonly client: GoogleClient) {}

  async open(packageName: string): Promise<string> {
    const res = await this.client.request<{ id: string; expiryTimeSeconds: string }>({
      method: "POST",
      path: `/${encodeURIComponent(packageName)}/edits`,
    });
    return res.id;
  }

  async discard(packageName: string, editId: string): Promise<void> {
    try {
      await this.client.request({
        method: "DELETE",
        path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}`,
      });
    } catch {
      /* swallow — edit may have already expired */
    }
  }

  async commitManaged(packageName: string, editId: string): Promise<void> {
    await this.client.request({
      method: "POST",
      path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}:commit`,
      query: { changesNotSentForReview: "true" },
    });
  }

  async commitSimple(packageName: string, editId: string): Promise<void> {
    await this.client.request({
      method: "POST",
      path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}:commit`,
    });
  }

  async smartCommit(packageName: string, editId: string): Promise<CommitResult> {
    try {
      await this.commitManaged(packageName, editId);
      return {
        ok: true,
        strategy: "managed_publishing",
        message: "Committed (managed publishing)",
      };
    } catch (err1: unknown) {
      const msg1 = err1 instanceof Error ? err1.message : String(err1);

      if (/changesNotSentForReview must not be set/i.test(msg1)) {
        try {
          await this.commitSimple(packageName, editId);
          return {
            ok: true,
            strategy: "auto_review",
            message: "Committed (auto-review enabled)",
          };
        } catch (err2: unknown) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          return { ok: false, strategy: null, message: `Auto-review commit failed: ${msg2}` };
        }
      }

      if (
        /Only releases with status draft/i.test(msg1) ||
        /no committable releases/i.test(msg1) ||
        /no committable changes/i.test(msg1) ||
        /Cannot commit edits to a draft app/i.test(msg1)
      ) {
        // Draft app autosaves metadata; the commit failure is benign.
        await this.discard(packageName, editId);
        return {
          ok: true,
          strategy: "draft_autosave",
          message: "Draft app — metadata auto-saved (commit not required)",
        };
      }

      return { ok: false, strategy: null, message: msg1 };
    }
  }

  /**
   * Wraps `fn` in an edit session that is ALWAYS committed (smart) or
   * discarded on the way out. Use when the body performs mutations.
   */
  async withEdit<T>(
    packageName: string,
    fn: (editId: string) => Promise<T>,
  ): Promise<{ result: T; commitResult: CommitResult }> {
    const editId = await this.open(packageName);
    let result: T;
    try {
      result = await fn(editId);
    } catch (err: unknown) {
      await this.discard(packageName, editId);
      throw err instanceof Error
        ? err
        : new UpstreamError("google", "Edit session failed", { details: { raw: err } });
    }
    const commitResult = await this.smartCommit(packageName, editId);
    return { result, commitResult };
  }

  /**
   * Wraps `fn` in an edit session that is always discarded. Use for
   * read-only reconnaissance to avoid bloating the user's edit history.
   */
  async withReadOnly<T>(
    packageName: string,
    fn: (editId: string) => Promise<T>,
  ): Promise<T> {
    const editId = await this.open(packageName);
    try {
      return await fn(editId);
    } finally {
      await this.discard(packageName, editId);
    }
  }
}
