/**
 * Apple App Store Connect builds + submission adapter.
 *
 * "Builds" are uploads from Xcode / Transporter that materialise in
 * App Store Connect as `builds` related to a `preReleaseVersion`. We
 * never upload binaries from the web app (Apple has no public REST
 * upload for IPAs); we only LIST + SUBMIT.
 *
 * Submission is a 3-step protocol:
 *   1. POST /reviewSubmissions    — open a review submission for the app
 *   2. POST /reviewSubmissionItems — link the version
 *   3. PATCH /reviewSubmissions/:id { submitted: true } — send it in
 *
 * NewVersion creates a fresh `appStoreVersions` row so editors can start
 * preparing 1.2.4 while 1.2.3 sits in review.
 */

import { NotFoundError } from "../../errors";
import type { AppleClient } from "./AppleClient";

export interface AppleBuild {
  id: string;
  version: string;                  // CFBundleShortVersionString (matches the app's marketing version)
  buildNumber: string;              // CFBundleVersion (matches the build number from Xcode)
  uploadedDate: string;             // ISO 8601
  processingState: "PROCESSING" | "VALID" | "INVALID" | "FAILED" | string;
  usesNonExemptEncryption: boolean | null;
  iconAssetToken: string | null;
}

interface JsonApiBuild {
  id: string;
  type: "builds";
  attributes: {
    version: string;
    uploadedDate: string;
    processingState: string;
    usesNonExemptEncryption: boolean | null;
    iconAssetToken?: string | null;
  };
  relationships?: {
    preReleaseVersion?: { data: { id: string; type: "preReleaseVersions" } };
  };
}

interface JsonApiPreReleaseVersion {
  id: string;
  type: "preReleaseVersions";
  attributes: { version: string };
}

interface JsonApiBuildsResponse {
  data: JsonApiBuild[];
  included?: (JsonApiPreReleaseVersion | { type: string })[];
}

export interface SubmissionResult {
  submissionId: string;
  itemId: string;
  status: "SUBMITTED" | "FAILED";
  message?: string;
}

export class AppleBuilds {
  constructor(private readonly client: AppleClient) {}

  /**
   * Lists builds for an app, newest first. Includes preReleaseVersions so
   * we can resolve the human-readable marketing version (e.g. 1.2.3) —
   * Apple keeps version in preReleaseVersion and buildNumber in build.version.
   */
  async listBuilds(storeAppId: string, limit = 25): Promise<AppleBuild[]> {
    const res = await this.client.request<JsonApiBuildsResponse>({
      method: "GET",
      path: "/builds",
      query: {
        "filter[app]": storeAppId,
        sort: "-uploadedDate",
        limit,
        include: "preReleaseVersion",
        // Guarantee the compliance field is present (App Store's #1 submit gate)
        // AND keep the preReleaseVersion relationship so the marketing version
        // resolves (a fields[builds] list omitting it drops the relationship).
        "fields[builds]":
          "version,uploadedDate,processingState,usesNonExemptEncryption,iconAssetToken,preReleaseVersion",
        "fields[preReleaseVersions]": "version",
      },
    });

    const versionMap = new Map<string, string>();
    for (const inc of res.included ?? []) {
      if (inc.type === "preReleaseVersions") {
        const v = inc as JsonApiPreReleaseVersion;
        versionMap.set(v.id, v.attributes.version);
      }
    }

    return res.data.map((b) => {
      const preReleaseId = b.relationships?.preReleaseVersion?.data?.id;
      return {
        id: b.id,
        version: preReleaseId ? versionMap.get(preReleaseId) ?? "" : "",
        buildNumber: b.attributes.version,
        uploadedDate: b.attributes.uploadedDate,
        processingState: b.attributes.processingState,
        usesNonExemptEncryption: b.attributes.usesNonExemptEncryption,
        iconAssetToken: b.attributes.iconAssetToken ?? null,
      };
    });
  }

  /**
   * 3-step Apple review submission. Returns the new submissionId.
   * If any step fails the partial submission is left in App Store Connect
   * for manual cleanup (Apple doesn't expose a delete endpoint for them).
   */
  async submitForReview(
    storeAppId: string,
    versionId: string,
    platform: "IOS" | "MAC_OS" | "TV_OS" = "IOS",
  ): Promise<SubmissionResult> {
    // Step 1 — open the submission. Apple allows ONE open submission per
    // app+platform, so reuse an existing not-yet-submitted one (idempotent on a
    // re-click after a partial failure) rather than hitting a 409.
    let submissionId = await this.findOpenSubmission(storeAppId, platform);
    if (!submissionId) {
      const created = await this.client.request<{ data: { id: string } }>({
        method: "POST",
        path: "/reviewSubmissions",
        body: {
          data: {
            type: "reviewSubmissions",
            attributes: { platform },
            relationships: {
              app: { data: { type: "apps", id: storeAppId } },
            },
          },
        },
      });
      submissionId = created.data.id;
    }

    // Step 2 — attach the version
    const item = await this.client.request<{ data: { id: string } }>({
      method: "POST",
      path: "/reviewSubmissionItems",
      body: {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
            appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
          },
        },
      },
    });

    // Step 3 — send
    await this.client.request({
      method: "PATCH",
      path: `/reviewSubmissions/${encodeURIComponent(submissionId)}`,
      body: {
        data: {
          type: "reviewSubmissions",
          id: submissionId,
          attributes: { submitted: true },
        },
      },
    });

    return { submissionId, itemId: item.data.id, status: "SUBMITTED" };
  }

  async createAppStoreVersion(input: {
    storeAppId: string;
    versionString: string;
    platform?: "IOS" | "MAC_OS" | "TV_OS";
    releaseType?: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";
  }): Promise<{ versionId: string }> {
    const res = await this.client.request<{ data: { id: string } }>({
      method: "POST",
      path: "/appStoreVersions",
      body: {
        data: {
          type: "appStoreVersions",
          attributes: {
            versionString: input.versionString,
            platform: input.platform ?? "IOS",
            releaseType: input.releaseType ?? "MANUAL",
          },
          relationships: { app: { data: { type: "apps", id: input.storeAppId } } },
        },
      },
    });
    return { versionId: res.data.id };
  }

  /** Attaches the given build to the version so submission can include it. */
  async attachBuildToVersion(versionId: string, buildId: string): Promise<void> {
    await this.client.request({
      method: "PATCH",
      path: `/appStoreVersions/${encodeURIComponent(versionId)}/relationships/build`,
      body: { data: { type: "builds", id: buildId } },
    });
  }

  /** Declares a build's export-compliance encryption status (App Store's #1
   *  submit gate). usesEncryption=false → standard "no/exempt encryption". */
  async updateBuildCompliance(buildId: string, usesNonExemptEncryption: boolean): Promise<void> {
    await this.client.request({
      method: "PATCH",
      path: `/builds/${encodeURIComponent(buildId)}`,
      body: {
        data: { type: "builds", id: buildId, attributes: { usesNonExemptEncryption } },
      },
    });
  }

  /** The id of an open (not-yet-submitted) review submission for this app, if
   *  any — so a re-click reuses it instead of triggering Apple's 409. */
  private async findOpenSubmission(
    storeAppId: string,
    platform: "IOS" | "MAC_OS" | "TV_OS",
  ): Promise<string | null> {
    try {
      const res = await this.client.request<{ data: { id: string }[] }>({
        method: "GET",
        path: "/reviewSubmissions",
        query: {
          "filter[app]": storeAppId,
          "filter[platform]": platform,
          "filter[state]": "READY_FOR_REVIEW",
          limit: 1,
        },
      });
      return res.data[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Cancels the open review submission for this app (mirrors Unity's
   *  CancelSubmissionAsync) so the user can clear a stuck/partial submit. */
  async cancelSubmission(
    storeAppId: string,
    platform: "IOS" | "MAC_OS" | "TV_OS" = "IOS",
  ): Promise<boolean> {
    const id = await this.findOpenSubmission(storeAppId, platform);
    if (!id) return false;
    await this.client.request({
      method: "PATCH",
      path: `/reviewSubmissions/${encodeURIComponent(id)}`,
      body: { data: { type: "reviewSubmissions", id, attributes: { canceled: true } } },
    });
    return true;
  }
}

// Silence unused
void NotFoundError;
