import { describe, it, expect } from "vitest";
import { wrapLines } from "./wrap.js";

// Measure by character count so tests are deterministic (no canvas needed).
const byChars = (s: string) => s.length;

describe("wrapLines", () => {
  it("wraps Latin text at the width", () => {
    expect(wrapLines(byChars, "abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });

  it("keeps short text on one line", () => {
    expect(wrapLines(byChars, "hi", 10)).toEqual(["hi"]);
  });

  it("breaks on explicit newlines", () => {
    expect(wrapLines(byChars, "ab\ncd", 10)).toEqual(["ab", "cd"]);
  });

  it("wraps character-dense (CJK) text without spaces", () => {
    expect(wrapLines(byChars, "音量調到三十", 2)).toEqual(["音量", "調到", "三十"]);
  });
});
