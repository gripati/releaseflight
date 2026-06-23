import { toGooglePlayLocale, isGooglePlaySupported } from "../../locale";
import type { GoogleClient } from "./GoogleClient";
import { GoogleEditSession } from "./GoogleEditSession";

export interface GoogleListing {
  language: string;
  title: string;
  shortDescription: string;
  fullDescription: string;
  video: string | null;
}

export interface UpsertListingInput {
  canonicalLocale: string;
  name: string;
  shortDescription: string;
  description: string;
  videoUrl?: string | null;
}

export interface PushSummary {
  succeeded: { canonical: string; google: string }[];
  failed: { canonical: string; google?: string; error: string }[];
  unsupported: { canonical: string; attempted: string }[];
  commitStrategy: string | null;
}

/**
 * Google Play listings (title, shortDescription, fullDescription, video).
 * Always wraps mutations in an edit session and applies the smart-commit
 * pipeline at the end.
 */
export class GoogleListings {
  private readonly session: GoogleEditSession;
  constructor(private readonly client: GoogleClient) {
    this.session = new GoogleEditSession(client);
  }

  async fetchAll(packageName: string): Promise<Map<string, GoogleListing>> {
    return this.session.withReadOnly(packageName, async (editId) => {
      const res = await this.client.request<{ listings?: GoogleListing[] }>({
        method: "GET",
        path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/listings`,
        silent: true,
      });
      const map = new Map<string, GoogleListing>();
      for (const l of res.listings ?? []) map.set(l.language, l);
      return map;
    });
  }

  async pushAll(input: {
    packageName: string;
    listings: UpsertListingInput[];
    onProgress?: (current: number, total: number, locale: string) => void;
  }): Promise<PushSummary> {
    const summary: PushSummary = {
      succeeded: [],
      failed: [],
      unsupported: [],
      commitStrategy: null,
    };

    const { commitResult } = await this.session.withEdit(input.packageName, async (editId) => {
      let i = 0;
      for (const item of input.listings) {
        i += 1;
        input.onProgress?.(i, input.listings.length, item.canonicalLocale);

        const googleLocale = toGooglePlayLocale(item.canonicalLocale);
        if (!isGooglePlaySupported(googleLocale)) {
          summary.unsupported.push({ canonical: item.canonicalLocale, attempted: googleLocale });
          continue;
        }

        try {
          await this.client.request({
            method: "PUT",
            path: `/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(googleLocale)}`,
            body: {
              language: googleLocale,
              title: item.name,
              shortDescription: item.shortDescription,
              fullDescription: item.description,
              video: item.videoUrl ?? "",
            },
          });
          summary.succeeded.push({ canonical: item.canonicalLocale, google: googleLocale });
        } catch (err: unknown) {
          summary.failed.push({
            canonical: item.canonicalLocale,
            google: googleLocale,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    summary.commitStrategy = commitResult.strategy ?? null;
    return summary;
  }
}
