import { describe, it, expect } from "vitest";
import { addressedTo, afterWakeWord, matchWake, parseWakeAliases } from "./wake.js";
import { parseArgs } from "./args.js";
import { configAsEnv } from "./config.js";

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

describe("spellings a transcriber produces for the wake word", () => {
  // The first live run on the Pi: "hearth, turn off the light" came back as "Hard turn off light." and was dropped.
  it("takes a known mishearing as the wake word when it is the first word and a command follows", () => {
    expect(afterWakeWord("Hard turn off light.", "hearth")).toBe("turn off light");
    expect(afterWakeWord("Hard, turn it down", "hearth")).toBe("turn it down");
    expect(afterWakeWord("Okay hart mute", "hearth")).toBe("mute");
    expect(afterWakeWord("Heart! what time is it", "hearth")).toBe("what time is it");
  });

  it("does not take an ordinary sentence that merely contains the word, or starts with it and says nothing more", () => {
    expect(afterWakeWord("That is hard to say", "hearth")).toBeUndefined();     // not the first word
    expect(afterWakeWord("I love you with all my heart", "hearth")).toBeUndefined();
    expect(afterWakeWord("Hard.", "hearth")).toBeUndefined();                    // the alias alone is not a request
    expect(afterWakeWord("Hard-boiled eggs are fine", "hearth")).toBeUndefined();   // "Hard-boiled" is not the word "hard"
  });

  it("the exact word still wins, anywhere in the sentence", () => {
    expect(afterWakeWord("turn it down, hearth", "hearth")).toBe("turn it down");
    expect(matchWake("Hearth, mute", "hearth")?.via).toBe("word");
    expect(matchWake("Hard mute", "hearth")?.via).toEqual({ alias: "hard" });
  });

  it("can be turned off, or replaced, and a wake word with no built-in list has none", () => {
    expect(afterWakeWord("Hard turn it down", "hearth", false)).toBeUndefined();
    expect(afterWakeWord("Hard turn it down", "hearth", ["harth"])).toBeUndefined();
    expect(afterWakeWord("Harth turn it down", "hearth", ["harth"])).toBe("turn it down");
    expect(afterWakeWord("Computer turn it down", "jarvis")).toBeUndefined();
  });

  it("is configurable by the environment and the config file, and the flag beats both", () => {
    expect(parseWakeAliases(undefined)).toBeUndefined();
    expect(parseWakeAliases("off")).toBe(false);
    expect(parseWakeAliases(" harth , hart ")).toEqual(["harth", "hart"]);
    expect(parseArgs(["hi"]).wakeAliases).toBeUndefined();
    expect(parseArgs(["hi"], { HEARTH_WAKE_ALIASES: "off" }).wakeAliases).toBe(false);
    expect(parseArgs(["hi"], configAsEnv({ wakeAliases: ["harth"] })).wakeAliases).toEqual(["harth"]);
    expect(parseArgs(["hi"], configAsEnv({ wakeAliases: false })).wakeAliases).toBe(false);
    expect(parseArgs(["--no-wake-aliases", "hi"], configAsEnv({ wakeAliases: ["harth"] })).wakeAliases).toBe(false);
  });
});

describe("an utterance a detector already addressed to us", () => {
  it("is the command, whether or not the replayed audio still has the wake word's tail on the front", () => {
    expect(addressedTo("turn it down", "hearth")).toEqual({ command: "turn it down", via: "detector" });
    expect(addressedTo("Hearth, turn it down", "hearth")).toMatchObject({ command: "turn it down", via: "word" });
    expect(addressedTo("Hard turn it down", "hearth")).toMatchObject({ command: "turn it down", via: { alias: "hard" } });
  });

  it("treats the word alone — as the recogniser spelled it — as the wake word, not as a command to run", () => {
    expect(addressedTo("Hearth?", "hearth").command).toBe("");
    expect(addressedTo("Hard.", "hearth")).toEqual({ command: "", via: { alias: "hard" } });
    expect(addressedTo("Hard.", "hearth", false)).toMatchObject({ command: "Hard", via: "detector" });   // aliases off: it is just a word
  });
});
