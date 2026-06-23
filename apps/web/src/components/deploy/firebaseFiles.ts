/**
 * Client-side parsing for the Firebase setup files a user drops in:
 *  - service-account.json      → auth (client_email / private_key / project_id)
 *  - GoogleService-Info.plist  → iOS App ID (GOOGLE_APP_ID) + project id
 *  - google-services.json      → Android App ID (mobilesdk_app_id) + project id
 */

export interface FirebaseFileParse {
  saJson?: string;
  iosAppId?: string;
  androidAppId?: string;
  projectId?: string;
  detected: string[];
}

/** Parse a flat GoogleService-Info.plist (<dict> of <key>/<string>) in the browser. */
export function parsePlist(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const dict = doc.querySelector("dict");
    if (!dict) return out;
    const nodes = Array.from(dict.children);
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i]?.tagName === "key") {
        out[nodes[i]?.textContent ?? ""] = nodes[i + 1]?.textContent ?? "";
      }
    }
  } catch {
    /* malformed plist */
  }
  return out;
}

export async function parseFirebaseFiles(files: FileList | File[]): Promise<FirebaseFileParse> {
  const out: FirebaseFileParse = { detected: [] };
  for (const f of Array.from(files)) {
    const text = await f.text();
    if (f.name.toLowerCase().endsWith(".plist") || text.includes("<plist")) {
      const kv = parsePlist(text);
      if (kv.GOOGLE_APP_ID) {
        out.iosAppId = kv.GOOGLE_APP_ID;
        out.detected.push(`iOS app id (${kv.GOOGLE_APP_ID})`);
      }
      if (kv.PROJECT_ID) out.projectId = kv.PROJECT_ID;
      continue;
    }
    try {
      const j = JSON.parse(text) as {
        type?: string;
        client_email?: string;
        project_id?: string;
        project_info?: { project_id?: string };
        client?: { client_info?: { mobilesdk_app_id?: string } }[];
      };
      if (j.type === "service_account") {
        out.saJson = text;
        if (j.project_id) out.projectId = j.project_id;
        out.detected.push(`Service account (${j.client_email ?? ""})`);
      } else if (j.project_info || j.client) {
        if (j.project_info?.project_id) out.projectId = j.project_info.project_id;
        const aid = j.client?.[0]?.client_info?.mobilesdk_app_id;
        if (aid) {
          out.androidAppId = aid;
          out.detected.push(`Android app id (${aid})`);
        }
      }
    } catch {
      /* not a JSON we recognise */
    }
  }
  return out;
}
