import fs from "node:fs";
import path from "node:path";

/** Shallow: first entry in `dir` whose name ends with `suffix` (e.g. ".xcworkspace"). */
export function findFirstBySuffix(dir: string, suffix: string): string | null {
  try {
    const match = fs.readdirSync(dir).find((f) => f.endsWith(suffix));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

/** Recursively find files under `dir` whose name ends with `suffix`,
 *  returning the most-recently-modified match (newest build wins). */
export function findNewestBySuffix(dir: string, suffix: string): string | null {
  let best: { p: string; mtime: number } | null = null;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(full);
      } else if (e.name.endsWith(suffix)) {
        const m = fs.statSync(full).mtimeMs;
        if (!best || m > best.mtime) best = { p: full, mtime: m };
      }
    }
  };
  walk(dir);
  return best ? (best as { p: string }).p : null;
}
