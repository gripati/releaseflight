/**
 * Generates an Xcode ExportOptions.plist for `xcodebuild -exportArchive`.
 *
 * method:
 *   - "release-testing"   → ad-hoc successor (Xcode 15.3+) — for Firebase distribution
 *   - "app-store-connect" → App Store / TestFlight upload
 */
export interface ExportOptions {
  method: "release-testing" | "app-store-connect";
  teamId?: string | null;
  signingStyle?: "automatic" | "manual";
}

export function generateExportOptions(opts: ExportOptions): string {
  const dict: string[] = [`  <key>method</key>\n  <string>${opts.method}</string>`];
  if (opts.teamId) {
    dict.push(`  <key>teamID</key>\n  <string>${escapeXml(opts.teamId)}</string>`);
  }
  dict.push(`  <key>signingStyle</key>\n  <string>${opts.signingStyle ?? "automatic"}</string>`);
  dict.push(`  <key>stripSwiftSymbols</key>\n  <true/>`);
  dict.push(`  <key>compileBitcode</key>\n  <false/>`);
  if (opts.method === "app-store-connect") {
    dict.push(`  <key>uploadSymbols</key>\n  <true/>`);
    dict.push(`  <key>manageAppVersionAndBuildNumber</key>\n  <false/>`);
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    dict.join("\n"),
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}
