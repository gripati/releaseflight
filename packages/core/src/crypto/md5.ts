import { createHash } from "node:crypto";

export function md5Hex(input: string | Buffer): string {
  return createHash("md5").update(input).digest("hex");
}

export function md5OfBuffer(buf: Buffer): string {
  return md5Hex(buf);
}
