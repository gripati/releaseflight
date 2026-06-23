import sharp from "sharp";

export interface ThumbnailOptions {
  /** Longest edge in pixels. */
  size?: number;
  format?: "webp" | "jpeg" | "png";
  quality?: number;
}

export interface ImageMeta {
  width: number;
  height: number;
  format: string;
  fileSize: number;
}

/**
 * Pre-flight image metadata. Throws on decompression bombs > 50 MP.
 */
export async function detectImageMeta(input: Buffer): Promise<ImageMeta> {
  const img = sharp(input, { limitInputPixels: 50_000_000 });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Failed to decode image dimensions");
  }
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format ?? "unknown",
    fileSize: input.length,
  };
}

/**
 * Generates a thumbnail. Default: 256px webp, q80.
 */
export async function generateThumbnail(
  input: Buffer,
  opts: ThumbnailOptions = {},
): Promise<{ buffer: Buffer; contentType: string; width: number; height: number }> {
  const size = opts.size ?? 256;
  const format = opts.format ?? "webp";
  const quality = opts.quality ?? 80;

  const pipeline = sharp(input, { limitInputPixels: 50_000_000 }).resize(size, size, {
    fit: "inside",
    withoutEnlargement: true,
  });

  let buffer: Buffer;
  let contentType: string;
  if (format === "webp") {
    buffer = await pipeline.webp({ quality }).toBuffer();
    contentType = "image/webp";
  } else if (format === "jpeg") {
    buffer = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    contentType = "image/jpeg";
  } else {
    buffer = await pipeline.png({ quality }).toBuffer();
    contentType = "image/png";
  }

  const meta = await sharp(buffer).metadata();
  return {
    buffer,
    contentType,
    width: meta.width ?? size,
    height: meta.height ?? size,
  };
}
