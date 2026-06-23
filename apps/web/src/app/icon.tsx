import { ImageResponse } from "next/og";

/**
 * App icon — generated on-demand by Next.js (32×32 PNG) so we don't ship a
 * binary in the repo. The Release Flight mark is a paper-plane / takeoff glyph
 * (the "release & ship" metaphor) in the brand signal-orange over the dark
 * paper background.
 */
export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0e0e0c",
          borderRadius: 7,
        }}
      >
        <svg width="21" height="21" viewBox="0 0 24 24" fill="#e84b1e">
          {/* Paper-plane / navigation glyph, pointing up-right — flight & launch */}
          <path d="M3 11l19-9-9 19-2-8-8-2z" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
