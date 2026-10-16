import { describe, expect, it } from "vitest";
import { createSentenceSplitter, createSpeechQueue, createStreamSpeaker, speakable } from "./speech-stream.js";

/** Feed text a few characters at a time, as a stream would, and collect every sentence in order. */
function split(text: string, step = 3, o = {}): string[] {
  const s = createSentenceSplitter(o);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) out.push(...s.push(text.slice(i, i + step)));
  out.push(...s.flush());
  return out;
}

describe("sentence splitter", () => {
  it("cuts at the end of a sentence as soon as it is known — and gives the same sentences however the text is chunked", () => {
    const text = "The TV is on. The volume is at forty. Anything else?";
    const expected = ["The TV is on.", "The volume is at forty.", "Anything else?"];
    for (const step of [1, 2, 3, 7, 50]) expect(split(text, step), `step ${step}`).toEqual(expected);
  });

  it("does not speak a sentence before it has ended", () => {
    const s = createSentenceSplitter();
    expect(s.push("The TV is on and the volume is")).toEqual([]);
    expect(s.push(" at forty. And")).toEqual(["The TV is on and the volume is at forty."]);
    expect(s.flush()).toEqual(["And"]);
  });

  it("a full stop at the very end waits, because it may be the start of a number", () => {
    const s = createSentenceSplitter();
    expect(s.push("The CPU is at 48.")).toEqual([]);                 // "48." or "48.2"?
    expect(s.push("2 degrees.")).toEqual([]);                        // still the end of the text, still waiting
    expect(s.flush()).toEqual(["The CPU is at 48.2 degrees."]);
  });

  it("does not split inside a number, an abbreviation or an initial", () => {
    expect(split("It is 48.2 degrees and 312.5 MB are free. Fine.")).toEqual(["It is 48.2 degrees and 312.5 MB are free.", "Fine."]);
    expect(split("Dr. Smith called, e.g. about the TV. Ok then.")).toEqual(["Dr. Smith called, e.g. about the TV.", "Ok then."]);
  });

  it("ends Chinese sentences at once, with no space needed, and handles a mix", () => {
    const s = createSentenceSplitter({ minChars: 1 });
    expect(s.push("電視已經開了。音量是四十！")).toEqual(["電視已經開了。", "音量是四十！"]);
    expect(split("好的，我把音量調到 40。The TV is on. 還有嗎？", 2, { minChars: 1 })).toEqual(["好的，我把音量調到 40。", "The TV is on.", "還有嗎？"]);
  });

  it("holds a very short sentence and joins it to the next, so \"Yes.\" is not an utterance of its own", () => {
    expect(split("Yes. The TV is on.")).toEqual(["Yes. The TV is on."]);
    expect(split("Yes. The TV is on.", 3, { minChars: 1 })).toEqual(["Yes.", "The TV is on."]);
  });

  it("keeps a closing quote with its sentence, and treats ?! and ... as one stop", () => {
    expect(split('He said "turn it down." Then he left.')).toEqual(['He said "turn it down."', "Then he left."]);
    expect(split("Really?! I did not know... Well, now I do.", 3, { minChars: 1 })).toEqual(["Really?!", "I did not know...", "Well, now I do."]);
  });

  it("a line break is a break, and markdown is not read aloud", () => {
    const reply = "The Hearth device is **online**.\n\n- **CPU Temperature:** 48.2 °C\n- **Free Memory:** 312 MB\n";
    expect(split(reply, 4, { minChars: 1 })).toEqual(["The Hearth device is online.", "CPU Temperature: 48.2 °C", "Free Memory: 312 MB"]);
  });

  it("a long run with no stop is cut at a comma or space rather than waiting for the end of the reply", () => {
    const run = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen";
    const out = split(run, 5, { maxChars: 60 });
    expect(out.length).toBeGreaterThan(1);
    expect(out.join(" ")).toBe(run);                                   // nothing lost, nothing added
    for (const piece of out.slice(0, -1)) expect(piece.length).toBeLessThanOrEqual(60);
  });

  it("flush speaks what is left, and an empty or blank reply speaks nothing", () => {
    expect(split("No full stop at the end")).toEqual(["No full stop at the end"]);
    expect(split("")).toEqual([]);
    expect(split("  \n \n ")).toEqual([]);
  });
});

describe("speakable", () => {
  it("removes formatting and keeps every word and the punctuation", () => {
    expect(speakable("**Status:** Online")).toBe("Status: Online");
    expect(speakable("## Heading\n- item one\n1. item two")).toBe("Heading item one item two");
    expect(speakable("see [the docs](https://example.com/x) now, `ls -l`")).toBe("see the docs now, ls -l");
    expect(speakable("a  \n  b")).toBe("a b");
  });
});

describe("speech queue", () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("speaks in order, one at a time", async () => {
    const log: string[] = [];
    const q = createSpeechQueue(async (t) => { log.push(`start ${t}`); await delay(t === "a" ? 15 : 1); log.push(`end ${t}`); });
    q.enqueue("a"); q.enqueue("b"); q.enqueue("c");
    await q.idle();
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(q.spoken).toBe(3);
  });

  it("a sentence that fails does not silence the rest, and the failure is reported", async () => {
    const said: string[] = [], errors: string[] = [];
    const q = createSpeechQueue(async (t) => { if (t === "bad") throw new Error("espeak-ng exited 1"); said.push(t); }, (e, t) => errors.push(`${t}: ${(e as Error).message}`));
    q.enqueue("one"); q.enqueue("bad"); q.enqueue("two");
    await q.idle();
    expect(said).toEqual(["one", "two"]);
    expect(errors).toEqual(["bad: espeak-ng exited 1"]);
  });

  it("cancel drops what has not started, lets the current sentence finish, and ignores later ones", async () => {
    const said: string[] = [];
    const q = createSpeechQueue(async (t) => { await delay(10); said.push(t); });
    q.enqueue("one"); q.enqueue("two"); q.enqueue("three");
    await delay(2);               // "one" has started
    q.cancel();
    q.enqueue("four");
    await q.idle();
    expect(said).toEqual(["one"]);
  });
});

describe("stream speaker", () => {
  it("speaks each sentence while the reply is still arriving, and finish waits for the last one", async () => {
    let clock = 0;
    const said: Array<{ text: string; at: number }> = [];
    const speaker = createStreamSpeaker(async (t) => { said.push({ text: t, at: clock }); }, { now: () => clock });

    const deltas = ["The Hearth ", "device is ", "online. ", "CPU is at ", "48.2 °C, ", "312 MB free."];
    for (const d of deltas.slice(0, 3)) { clock += 100; speaker.onDelta(d); }
    await Promise.resolve(); await Promise.resolve();
    // The first sentence is already out, three deltas into a six-delta reply.
    expect(said.map((s) => s.text)).toEqual(["The Hearth device is online."]);
    expect(speaker.firstSentenceMs).toBe(200);                        // second delta to the full stop's arrival: 100 ms in → +200

    for (const d of deltas.slice(3)) { clock += 100; speaker.onDelta(d); }
    await speaker.finish();
    expect(said.map((s) => s.text)).toEqual(["The Hearth device is online.", "CPU is at 48.2 °C, 312 MB free."]);
    expect(speaker.spokeAnything).toBe(true);
  });

  it("a stream with no words in it speaks nothing, so the caller knows to say the reply itself", async () => {
    const said: string[] = [];
    const speaker = createStreamSpeaker((t) => { said.push(t); });
    speaker.onDelta(""); speaker.onDelta("  ");
    await speaker.finish();
    expect(said).toEqual([]);
    expect(speaker.spokeAnything).toBe(false);
    expect(speaker.firstSentenceMs).toBeUndefined();
  });
});
