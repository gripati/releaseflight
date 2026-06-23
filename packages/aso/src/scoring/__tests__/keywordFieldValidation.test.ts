import { describe, expect, test } from "vitest";
import {
  validateKeywordToken,
  validateKeywordsField,
} from "../keywordFieldValidation";

describe("validateKeywordToken — single token rules", () => {
  test("clean token returns no warnings", () => {
    expect(validateKeywordToken("brain", { appName: "Pixy Block Breaker" })).toEqual([]);
  });

  test("token shorter than 3 chars flagged TOO_SHORT", () => {
    const w = validateKeywordToken("hi");
    expect(w.some((x) => x.code === "TOO_SHORT")).toBe(true);
    expect(w[0]!.severity).toBe("warning");
  });

  test("token longer than 30 chars flagged TOO_LONG", () => {
    const w = validateKeywordToken("a".repeat(35));
    expect(w.some((x) => x.code === "TOO_LONG")).toBe(true);
    expect(w.find((x) => x.code === "TOO_LONG")?.severity).toBe("danger");
  });

  test("stop word flagged", () => {
    const w = validateKeywordToken("the");
    expect(w.some((x) => x.code === "STOP_WORD")).toBe(true);
  });

  test("special chars flagged INFO (non-blocking)", () => {
    const w = validateKeywordToken("rock & roll");
    expect(w.some((x) => x.code === "SPECIAL_CHAR" && x.severity === "info")).toBe(true);
  });

  test("digit-heavy token flagged NUMERIC_DRAG", () => {
    const w = validateKeywordToken("2024");
    expect(w.some((x) => x.code === "NUMERIC_DRAG")).toBe(true);
  });

  test.each([
    "candy crush", "subway surfers", "royal match", "tetris",
    "minecraft", "tiktok", "fortnite",
  ])("trademark pattern '%s' flagged DANGER", (kw) => {
    const w = validateKeywordToken(kw);
    expect(w.some((x) => x.code === "TRADEMARK_RISK" && x.severity === "danger")).toBe(true);
  });

  test("trademark check can be disabled", () => {
    const w = validateKeywordToken("candy crush", { checkTrademarks: false });
    expect(w.some((x) => x.code === "TRADEMARK_RISK")).toBe(false);
  });
});

describe("validateKeywordToken — slot overlap rules", () => {
  test("app name overlap detected", () => {
    const w = validateKeywordToken("block", {
      appName: "Pixy Block Breaker",
    });
    expect(w.some((x) => x.code === "APP_NAME_OVERLAP")).toBe(true);
  });

  test("title overlap detected", () => {
    const w = validateKeywordToken("breaker", {
      title: "Block Breaker Saga",
    });
    expect(w.some((x) => x.code === "TITLE_OVERLAP")).toBe(true);
  });

  test("subtitle overlap detected", () => {
    const w = validateKeywordToken("slice", {
      subtitle: "Slice Shapes & Smash Blocks",
    });
    expect(w.some((x) => x.code === "SUBTITLE_OVERLAP")).toBe(true);
  });

  test("app name takes precedence over title (higher weight)", () => {
    const w = validateKeywordToken("block", {
      appName: "Pixy Block Breaker",
      title: "Block Saga",
    });
    expect(w.find((x) => x.code === "APP_NAME_OVERLAP")).toBeDefined();
    expect(w.find((x) => x.code === "TITLE_OVERLAP")).toBeUndefined();
  });

  test("non-overlapping word doesn't trigger", () => {
    const w = validateKeywordToken("arcade", {
      appName: "Pixy Block Breaker",
      title: "Smash Blocks",
      subtitle: "Slice Shapes",
    });
    expect(w.some((x) => x.code.includes("OVERLAP"))).toBe(false);
  });
});

describe("validateKeywordToken — peer-keyword rules", () => {
  test("plural duplicate flagged", () => {
    const w = validateKeywordToken("game", { otherKeywords: ["games"] });
    expect(w.some((x) => x.code === "PLURAL_DUPLICATE")).toBe(true);
  });

  test("plural duplicate (-ies form)", () => {
    const w = validateKeywordToken("story", { otherKeywords: ["stories"] });
    expect(w.some((x) => x.code === "PLURAL_DUPLICATE")).toBe(true);
  });

  test("plural duplicate (-es form)", () => {
    const w = validateKeywordToken("box", { otherKeywords: ["boxes"] });
    expect(w.some((x) => x.code === "PLURAL_DUPLICATE")).toBe(true);
  });

  test("multi-word redundant when component words exist separately", () => {
    const w = validateKeywordToken("block breaker", {
      otherKeywords: ["block", "breaker"],
    });
    expect(w.some((x) => x.code === "MULTI_WORD_REDUNDANT")).toBe(true);
  });

  test("multi-word NOT redundant when only one component is present", () => {
    const w = validateKeywordToken("block breaker", {
      otherKeywords: ["block", "arcade"],
    });
    expect(w.some((x) => x.code === "MULTI_WORD_REDUNDANT")).toBe(false);
  });

  test("unique singular doesn't trigger plural-duplicate", () => {
    const w = validateKeywordToken("brain", { otherKeywords: ["puzzle", "offline"] });
    expect(w.some((x) => x.code === "PLURAL_DUPLICATE")).toBe(false);
  });
});

describe("validateKeywordsField — aggregate validation", () => {
  test("clean field returns no warnings + zero chars saved", () => {
    const r = validateKeywordsField("brain,puzzle,offline,arcade", {
      appName: "Sudoku Master",
      title: "Sudoku Master",
      subtitle: "Number Logic Game",
    });
    expect(r.totalCharsSaved).toBe(0);
    expect(r.worstSeverity).toBeNull();
  });

  test("dirty field aggregates total chars saved across all warnings", () => {
    // "block" overlaps appName (6 chars saved) +
    // "breaker" overlaps title (8 chars saved) +
    // "the" stop word (4 chars saved) +
    // "block breaker" multi-word redundant (14 chars saved)
    const r = validateKeywordsField("block,breaker,the,block breaker,arcade", {
      appName: "Pixy Block Breaker",
      title: "Pixy Block Breaker",
    });
    expect(r.totalCharsSaved).toBeGreaterThan(20);
    expect(r.worstSeverity).toBe("warning");
  });

  test("trademark presence escalates worst severity to danger", () => {
    const r = validateKeywordsField("block,candy crush,arcade");
    expect(r.worstSeverity).toBe("danger");
  });

  test("info-only warnings produce worstSeverity = 'info'", () => {
    const r = validateKeywordsField("rock & roll,music");
    expect(r.worstSeverity).toBe("info");
  });

  test("token list returned in order, with warnings per token", () => {
    const r = validateKeywordsField("game,games,arcade");
    expect(r.tokens).toHaveLength(3);
    expect(r.tokens[0]!.token).toBe("game");
    expect(r.tokens[0]!.warnings.some((w) => w.code === "PLURAL_DUPLICATE")).toBe(true);
    expect(r.tokens[1]!.warnings.some((w) => w.code === "PLURAL_DUPLICATE")).toBe(true);
    expect(r.tokens[2]!.warnings).toHaveLength(0);
  });

  test("empty field yields empty result", () => {
    const r = validateKeywordsField("", {});
    expect(r.tokens).toHaveLength(0);
    expect(r.totalCharsSaved).toBe(0);
    expect(r.worstSeverity).toBeNull();
  });
});
