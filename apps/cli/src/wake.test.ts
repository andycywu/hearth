import { describe, it, expect } from "vitest";
import { afterWakeWord } from "./wake.js";

describe("the attention word", () => {
  it("passes everything through when there is none", () => {
    expect(afterWakeWord("  turn it down ", undefined)).toBe("turn it down");
  });

  it("drops what was not said to us", () => {
    expect(afterWakeWord("could you pass the salt", "hearth")).toBeUndefined();
    // Part of another word is not the word.
    expect(afterWakeWord("the hearthstone is cold", "hearth")).toBeUndefined();
  });

  it("returns what came after the word, however the transcriber punctuated it", () => {
    expect(afterWakeWord("Hearth, turn it down.", "hearth")).toBe("turn it down");
    expect(afterWakeWord("hearth turn it down", "hearth")).toBe("turn it down");
    expect(afterWakeWord("HEARTH! mute", "hearth")).toBe("mute");
  });

  it("accepts the word at the end too, because people do that", () => {
    expect(afterWakeWord("turn it down, hearth", "hearth")).toBe("turn it down");
  });

  it("returns an empty string for the word alone, so the caller can answer", () => {
    expect(afterWakeWord("Hearth?", "hearth")).toBe("");
  });

  it("works with a Chinese attention word and Chinese punctuation", () => {
    expect(afterWakeWord("小爐，把聲音調小", "小爐")).toBe("把聲音調小");
    expect(afterWakeWord("把聲音調小", "小爐")).toBeUndefined();
  });
});
