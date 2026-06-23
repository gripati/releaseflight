import { UpstreamError, ValidationError } from "../../errors";
import type { GoogleAuth, GoogleCredentialMaterial } from "../google/GoogleAuth";
import { FIREBASE_SCOPES } from "./FirebaseClient";

// Google Cloud project-id grammar: 6–30 chars, lowercase letter first, then
// lowercase letters/digits/hyphens. Validated before interpolation into the
// Management API URL path so a malformed value can't inject path segments.
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/**
 * Firebase Management API (firebase.googleapis.com) — used to auto-discover an
 * app's Firebase App IDs from its service account, so the user doesn't have to
 * paste them or drop the GoogleService-Info.plist / google-services.json.
 */
const MGMT = "https://firebase.googleapis.com/v1beta1";

export interface FirebaseManagedApp {
  appId: string;
  displayName?: string;
  bundleId?: string; // iOS
  packageName?: string; // Android
}

export class FirebaseManagement {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly cred: GoogleCredentialMaterial,
  ) {}

  async listApps(projectId: string): Promise<{
    iosApps: FirebaseManagedApp[];
    androidApps: FirebaseManagedApp[];
  }> {
    if (!PROJECT_ID_RE.test(projectId)) {
      throw new ValidationError(`Invalid Firebase project id: ${projectId}`);
    }
    const token = await this.auth.getAccessToken(this.cred, FIREBASE_SCOPES.APP_DISTRIBUTION);

    const fetchApps = async (kind: "iosApps" | "androidApps"): Promise<FirebaseManagedApp[]> => {
      const res = await fetch(`${MGMT}/projects/${encodeURIComponent(projectId)}/${kind}?pageSize=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new UpstreamError("firebase", `List ${kind} failed: HTTP ${res.status.toString()} ${text}`);
      }
      const data = (await res.json()) as { apps?: FirebaseManagedApp[] };
      return data.apps ?? [];
    };

    const [iosApps, androidApps] = await Promise.all([fetchApps("iosApps"), fetchApps("androidApps")]);
    return { iosApps, androidApps };
  }
}
