/**
 * Video file validation by magic bytes. Apple App Previews require
 * ISO base media files (MP4 / MOV / M4V); a renamed PNG or random binary
 * is rejected here before we waste a `reserve + PUT chunks + commit` round
 * trip to App Store Connect.
 *
 * ISO base media file format (ISO/IEC 14496-12):
 *   bytes 4..7 contain the ASCII string "ftyp"
 *   bytes 8..11 contain the major brand ("isom", "mp42", "qt  ", "M4V ", ...)
 */

export interface VideoMagicByteResult {
  ok: boolean;
  detectedBrand: string | null;
  format: "mp4" | "quicktime" | "m4v" | "unknown";
  message?: string;
}

const QUICKTIME_BRANDS = new Set(["qt  ", "qt"]);
const M4V_BRANDS = new Set(["M4V ", "M4VP", "M4VH"]);
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "mp71",
  "avc1",
  "dash",
  "msnv",
]);

/** Inspects the first 12 bytes of a buffer for an ISO base media signature. */
export function detectVideoMagicBytes(buf: Buffer): VideoMagicByteResult {
  if (buf.length < 12) {
    return { ok: false, detectedBrand: null, format: "unknown", message: "Buffer too short" };
  }
  const ftypMarker = buf.subarray(4, 8).toString("ascii");
  if (ftypMarker !== "ftyp") {
    return {
      ok: false,
      detectedBrand: null,
      format: "unknown",
      message: `Missing 'ftyp' marker at offset 4 (found ${JSON.stringify(ftypMarker)})`,
    };
  }
  const brand = buf.subarray(8, 12).toString("ascii");

  if (QUICKTIME_BRANDS.has(brand)) return { ok: true, detectedBrand: brand, format: "quicktime" };
  if (M4V_BRANDS.has(brand)) return { ok: true, detectedBrand: brand, format: "m4v" };
  if (MP4_BRANDS.has(brand)) return { ok: true, detectedBrand: brand, format: "mp4" };

  // Unknown brand but ftyp present — Apple will likely accept; warn rather than reject.
  return {
    ok: true,
    detectedBrand: brand,
    format: "mp4",
    message: `Unknown brand "${brand}" — Apple may still accept`,
  };
}

/**
 * Convenience: maps detected format to the MIME type Apple's `appPreviews`
 * reserve endpoint requires. Falls back to the supplied browser-reported
 * mimeType if magic-byte detection is ambiguous.
 */
export function videoMimeType(
  detect: VideoMagicByteResult,
  browserReported?: string,
): "video/mp4" | "video/quicktime" | "video/x-m4v" {
  if (detect.format === "quicktime") return "video/quicktime";
  if (detect.format === "m4v") return "video/x-m4v";
  if (detect.format === "mp4") return "video/mp4";
  if (browserReported === "video/quicktime") return "video/quicktime";
  if (browserReported === "video/x-m4v") return "video/x-m4v";
  return "video/mp4";
}
