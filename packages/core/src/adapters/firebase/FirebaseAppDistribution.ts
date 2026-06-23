import { UpstreamError } from "../../errors";
import type { FirebaseClient } from "./FirebaseClient";

export interface FirebaseTesterGroup {
  /** Resource name `projects/{pn}/groups/{alias}`. */
  name: string;
  alias: string;
  displayName: string;
  testerCount?: number;
}

export interface FirebaseUploadResult {
  /** Resource name `projects/{pn}/apps/{appId}/releases/{releaseId}`. */
  releaseName: string;
  displayVersion?: string;
  buildVersion?: string;
  /** Firebase console deep-link to the release, when returned. */
  consoleUri?: string;
}

interface OperationResponse {
  name: string;
  done?: boolean;
  error?: { message?: string; code?: number };
  response?: {
    release?: {
      name?: string;
      displayVersion?: string;
      buildVersion?: string;
      firebaseConsoleUri?: string;
    };
  };
}

/**
 * Firebase App Distribution — upload an artifact (IPA / APK / AAB), wait for
 * processing, set release notes, and distribute to tester groups / emails.
 *
 * Mirrors the proven Unity GamePublisher flow (FirebaseAPI.cs):
 *   releases:upload → poll operation → PATCH releaseNotes → :distribute.
 */
export class FirebaseAppDistribution {
  constructor(private readonly client: FirebaseClient) {}

  /** Derives the GCP project number from a Firebase app id `1:NUMBER:plat:hash`. */
  static projectNumberFromAppId(firebaseAppId: string): string {
    const parts = firebaseAppId.split(":");
    if (parts.length < 2 || !parts[1]) {
      throw new UpstreamError("firebase", `Malformed Firebase app id: ${firebaseAppId}`);
    }
    return parts[1];
  }

  async uploadRelease(input: {
    firebaseAppId: string;
    body: Buffer;
    fileName: string;
    signal?: AbortSignal;
  }): Promise<{ operationName: string }> {
    const projectNumber = FirebaseAppDistribution.projectNumberFromAppId(input.firebaseAppId);
    return this.client.uploadBinary({
      projectNumber,
      firebaseAppId: input.firebaseAppId,
      body: input.body,
      fileName: input.fileName,
      signal: input.signal,
    });
  }

  /** Polls the upload operation until done; returns the release resource name. */
  async pollUploadOperation(
    operationName: string,
    opts: {
      timeoutMs?: number;
      intervalMs?: number;
      onTick?: (waitedMs: number) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<FirebaseUploadResult> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const intervalMs = opts.intervalMs ?? 5_000;
    const start = Date.now();
    for (;;) {
      if (opts.signal?.aborted) throw new UpstreamError("firebase", "cancelled");
      const op = await this.client.request<OperationResponse>({
        method: "GET",
        path: `/v1/${operationName}`,
      });
      if (op.done) {
        if (op.error) {
          throw new UpstreamError("firebase", op.error.message ?? "Upload processing failed");
        }
        const release = op.response?.release;
        if (!release?.name) {
          throw new UpstreamError("firebase", "Upload completed without a release name");
        }
        return {
          releaseName: release.name,
          displayVersion: release.displayVersion,
          buildVersion: release.buildVersion,
          consoleUri: release.firebaseConsoleUri,
        };
      }
      if (Date.now() - start > timeoutMs) {
        throw new UpstreamError("firebase", "Timed out waiting for Firebase to process the upload");
      }
      opts.onTick?.(Date.now() - start);
      await sleep(intervalMs);
    }
  }

  async setReleaseNotes(releaseName: string, notes: string): Promise<void> {
    await this.client.request<unknown>({
      method: "PATCH",
      path: `/v1/${releaseName}`,
      query: { updateMask: "releaseNotes.text" },
      body: { releaseNotes: { text: notes } },
    });
  }

  async distribute(input: {
    releaseName: string;
    groupAliases?: string[];
    testerEmails?: string[];
  }): Promise<void> {
    await this.client.request<unknown>({
      method: "POST",
      path: `/v1/${input.releaseName}:distribute`,
      body: {
        groupAliases: input.groupAliases ?? [],
        testerEmails: input.testerEmails ?? [],
      },
    });
  }

  /** Full convenience flow used by the deploy tail. */
  async upload(input: {
    firebaseAppId: string;
    body: Buffer;
    fileName: string;
    releaseNotes?: string;
    groupAliases?: string[];
    testerEmails?: string[];
    signal?: AbortSignal;
    onTick?: (waitedMs: number) => void;
  }): Promise<FirebaseUploadResult> {
    const { operationName } = await this.uploadRelease({
      firebaseAppId: input.firebaseAppId,
      body: input.body,
      fileName: input.fileName,
      signal: input.signal,
    });
    const result = await this.pollUploadOperation(operationName, { onTick: input.onTick });
    if (input.releaseNotes) {
      await this.setReleaseNotes(result.releaseName, input.releaseNotes);
    }
    if ((input.groupAliases?.length ?? 0) > 0 || (input.testerEmails?.length ?? 0) > 0) {
      await this.distribute({
        releaseName: result.releaseName,
        groupAliases: input.groupAliases,
        testerEmails: input.testerEmails,
      });
    }
    return result;
  }

  /** Lists ALL tester groups for a project (paginated) — used to populate the
   *  launcher's group multi-select. */
  async listGroups(firebaseAppId: string): Promise<FirebaseTesterGroup[]> {
    const projectNumber = FirebaseAppDistribution.projectNumberFromAppId(firebaseAppId);
    const out: FirebaseTesterGroup[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.client.request<{
        groups?: { name: string; displayName?: string; testerCount?: number }[];
        nextPageToken?: string;
      }>({
        method: "GET",
        path: `/v1/projects/${projectNumber}/groups`,
        query: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
      });
      for (const g of res.groups ?? []) {
        out.push({
          name: g.name,
          alias: g.name.split("/").pop() ?? g.name,
          displayName: g.displayName ?? g.name,
          testerCount: g.testerCount,
        });
      }
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
