import { describe, expect, test } from "vitest";
import { applyAstroSwaps, MAX_KEYWORDS_FIELD_CHARS } from "../applyAstroSwaps";

describe("applyAstroSwaps — replace in-place", () => {
  test("swaps a single weak token for a strong one, preserving position", () => {
    const r = applyAstroSwaps("alpha,beta,gamma", [
      { weakKeyword: "beta", strongKeyword: "stronger" },
    ]);
    expect(r.after).toBe("alpha,stronger,gamma");
    expect(r.applied).toBe(1);
    expect(r.pairResults).toEqual([
      { weakKeyword: "beta", strongKeyword: "stronger", status: "replaced" },
    ]);
  });

  test("case-insensitive weak match", () => {
    const r = applyAstroSwaps("Alpha,BETA,Gamma", [
      { weakKeyword: "beta", strongKeyword: "stronger" },
    ]);
    expect(r.after).toBe("Alpha,stronger,Gamma");
    expect(r.applied).toBe(1);
  });

  test("multiple in-place replacements", () => {
    const r = applyAstroSwaps("a,b,c,d", [
      { weakKeyword: "b", strongKeyword: "B2" },
      { weakKeyword: "d", strongKeyword: "D2" },
    ]);
    expect(r.after).toBe("a,B2,c,D2");
    expect(r.applied).toBe(2);
  });
});

describe("applyAstroSwaps — append new tokens", () => {
  test("null weak ⇒ append (status 'added')", () => {
    const r = applyAstroSwaps("alpha,beta", [
      { weakKeyword: null, strongKeyword: "gamma" },
    ]);
    // High-value appends go to the FRONT.
    expect(r.after).toBe("gamma,alpha,beta");
    expect(r.applied).toBe(1);
    expect(r.pairResults[0]?.status).toBe("added");
  });

  test("weakKeyword not in field ⇒ append with status 'weak-missing-appended'", () => {
    const r = applyAstroSwaps("alpha,beta", [
      { weakKeyword: "doesnt-exist", strongKeyword: "fresh" },
    ]);
    expect(r.after).toBe("fresh,alpha,beta");
    expect(r.pairResults[0]?.status).toBe("weak-missing-appended");
  });

  test("multiple appends preserve queue order", () => {
    const r = applyAstroSwaps("alpha", [
      { weakKeyword: null, strongKeyword: "first" },
      { weakKeyword: null, strongKeyword: "second" },
    ]);
    expect(r.after).toBe("first,second,alpha");
  });
});

describe("applyAstroSwaps — duplicate prevention", () => {
  test("does not add a token already in the field", () => {
    const r = applyAstroSwaps("alpha,beta,gamma", [
      { weakKeyword: null, strongKeyword: "gamma" },
    ]);
    expect(r.after).toBe("alpha,beta,gamma");
    expect(r.applied).toBe(0);
    expect(r.pairResults[0]?.status).toBe("duplicate");
  });

  test("duplicate check is case-insensitive", () => {
    const r = applyAstroSwaps("Alpha,GAMMA", [
      { weakKeyword: null, strongKeyword: "alpha" },
    ]);
    expect(r.pairResults[0]?.status).toBe("duplicate");
  });
});

describe("applyAstroSwaps — 100-char cap enforcement", () => {
  test("trims tail tokens when the result would exceed 100 chars", () => {
    // Each token is 18 chars × 5 = 90 + 4 commas = 94 chars. Adding one
    // 10-char token + comma takes us to 105 → over the cap.
    const base = [
      "puzzlexxxxxxxxxxx0",
      "puzzlexxxxxxxxxxx1",
      "puzzlexxxxxxxxxxx2",
      "puzzlexxxxxxxxxxx3",
      "puzzlexxxxxxxxxxx4",
    ];
    const field = base.join(",");
    expect(field.length).toBe(94);
    const r = applyAstroSwaps(field, [
      { weakKeyword: null, strongKeyword: "freshxxxxx" }, // 10 chars + 1 comma = +11 → 105 over cap
    ]);
    // "freshxxxxx" goes to FRONT, the tail loses a token.
    expect(r.after.length).toBeLessThanOrEqual(MAX_KEYWORDS_FIELD_CHARS);
    expect(r.after.startsWith("freshxxxxx,")).toBe(true);
    expect(r.after.endsWith("puzzlexxxxxxxxxxx4")).toBe(false);
  });

  test("flips appended token to 'skipped-cap' when it itself doesn't fit", () => {
    // Strong token is over 100 chars by itself — can never fit.
    const field = "alpha,beta";
    const overlongStrong = "z".repeat(101);
    const r = applyAstroSwaps(field, [
      { weakKeyword: null, strongKeyword: overlongStrong },
    ]);
    expect(r.applied).toBe(0);
    expect(r.pairResults[0]?.status).toBe("skipped-cap");
    // The original field is preserved (no tokens evicted because the
    // would-be append never made it into the result).
    expect(r.after).toBe("alpha,beta");
  });
});

describe("applyAstroSwaps — interaction with empty field", () => {
  test("empty field + new appends", () => {
    const r = applyAstroSwaps("", [
      { weakKeyword: null, strongKeyword: "first" },
      { weakKeyword: null, strongKeyword: "second" },
    ]);
    expect(r.after).toBe("first,second");
    expect(r.applied).toBe(2);
  });

  test("empty field + a weak-missing pair still appends the strong term", () => {
    const r = applyAstroSwaps("", [
      { weakKeyword: "ghost", strongKeyword: "real" },
    ]);
    expect(r.after).toBe("real");
    expect(r.pairResults[0]?.status).toBe("weak-missing-appended");
  });
});

describe("applyAstroSwaps — combined replace + append + cap", () => {
  test("mixed batch of replace and append, respecting cap", () => {
    const field = "alpha,beta,gamma,delta";
    const r = applyAstroSwaps(field, [
      { weakKeyword: "beta", strongKeyword: "B2" },
      { weakKeyword: null, strongKeyword: "epsilon" },
      { weakKeyword: "gamma", strongKeyword: "G2" },
    ]);
    // Replacements happen in-place (B2 in beta's slot, G2 in gamma's slot)
    // The append "epsilon" goes to the front.
    expect(r.after).toBe("epsilon,alpha,B2,G2,delta");
    expect(r.applied).toBe(3);
  });

  test("appliedKeywords set reflects everything actually applied", () => {
    // alpha gets replaced by A2; new is appended; gamma is already in
    // the field so the second pair's "gamma" attempt is treated as a
    // duplicate.
    const r = applyAstroSwaps("alpha,beta,gamma", [
      { weakKeyword: "alpha", strongKeyword: "A2" },
      { weakKeyword: null, strongKeyword: "new" },
      { weakKeyword: null, strongKeyword: "gamma" },
    ]);
    expect(r.appliedKeywords).toEqual(new Set(["a2", "new"]));
    expect(r.pairResults.map((p) => p.status)).toEqual([
      "replaced",
      "added",
      "duplicate",
    ]);
  });
});
