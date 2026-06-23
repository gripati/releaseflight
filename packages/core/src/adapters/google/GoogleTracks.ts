/**
 * Google Play release-track management. The `tracks` endpoint groups
 * releases by audience: internal → alpha → beta → production. A release
 * combines one or more versionCodes (AABs uploaded earlier) and a status
 * (draft / inProgress / halted / completed). Staged rollouts use
 * `inProgress` plus a `userFraction` between 0 and 1.
 */
import { type CommitResult, GoogleEditSession } from "./GoogleEditSession";
import type { GoogleClient } from "./GoogleClient";

export type TrackName = "internal" | "alpha" | "beta" | "production";
export type ReleaseStatus = "draft" | "inProgress" | "halted" | "completed";

export interface ReleaseNote {
  language: string;
  text: string;
}

export interface TrackRelease {
  name?: string;
  versionCodes: string[];
  status: ReleaseStatus;
  userFraction?: number;
  releaseNotes?: ReleaseNote[];
}

export interface TrackInfo {
  track: TrackName | string;
  releases: TrackRelease[];
}

export interface AssignBundleInput {
  packageName: string;
  trackName: TrackName;
  versionCodes: number[];
  status: ReleaseStatus;
  userFraction?: number;
  releaseNotes?: ReleaseNote[];
}

export class GoogleTracks {
  private readonly session: GoogleEditSession;
  constructor(private readonly client: GoogleClient) {
    this.session = new GoogleEditSession(client);
  }

  async listTracks(packageName: string): Promise<TrackInfo[]> {
    return this.session.withReadOnly(packageName, async (editId) => {
      const res = await this.client.request<{ tracks?: TrackInfo[] }>({
        method: "GET",
        path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/tracks`,
        silent: true,
      });
      return res.tracks ?? [];
    });
  }

  async assignBundle(input: AssignBundleInput): Promise<CommitResult> {
    const { commitResult } = await this.session.withEdit(input.packageName, async (editId) => {
      const release: TrackRelease = {
        status: input.status,
        versionCodes: input.versionCodes.map((v) => v.toString()),
        ...(input.userFraction !== undefined ? { userFraction: input.userFraction } : {}),
        ...(input.releaseNotes ? { releaseNotes: input.releaseNotes } : {}),
      };
      await this.client.request({
        method: "PUT",
        path:
          `/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}` +
          `/tracks/${input.trackName}`,
        body: { track: input.trackName, releases: [release] },
      });
    });
    return commitResult;
  }
}
