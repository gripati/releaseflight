import { describe, expect, test } from "vitest";
import { formatRelativeTime } from "../Overview";

const NOW = new Date("2026-05-18T12:00:00.000Z").getTime();

describe("formatRelativeTime", () => {
  test("future timestamps report 'in the future' (don't render negatives)", () => {
    const iso = new Date(NOW + 10 * 60_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toBe("in the future");
  });

  test("under a minute → 'just now'", () => {
    const iso = new Date(NOW - 30_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toBe("just now");
  });

  test("under an hour → '{m}m ago'", () => {
    const iso = new Date(NOW - 17 * 60_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toBe("17m ago");
  });

  test("1-47 hours → '{h}h ago'", () => {
    const iso = new Date(NOW - 5 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toBe("5h ago");
  });

  test("≥ 48 hours → '{d}d ago'", () => {
    const iso = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toBe("3d ago");
  });

  test("deterministic — same iso + same nowMs always yields the same string", () => {
    const iso = "2026-05-17T12:00:00.000Z";
    const a = formatRelativeTime(iso, NOW);
    const b = formatRelativeTime(iso, NOW);
    expect(a).toBe(b);
  });
});
