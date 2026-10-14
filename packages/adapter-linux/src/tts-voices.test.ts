import { describe, expect, it } from "vitest";
import { espeakArgs, listTtsVoices, parseEspeakVoices, TTS_VARIANTS, validateTtsChoice } from "./tts-voices.js";
import { readRingState, ringStatePath, withStateFile } from "./ring-state.js";
import type { RingState, StatusRing } from "./leds.js";

/** `espeak-ng --voices`, as the living-room Pi 3B printed it (2026-10-14), trimmed. */
const VOICES = `Pty Language       Age/Gender VoiceName          File                 Other Languages
 5  af              --/M      Afrikaans          gmw/af
 5  cmn             --/M      Chinese_(Mandarin,_latin_as_English) sit/cmn              (zh-cmn 5)(zh 5)
 2  en-gb           --/M      English_(Great_Britain) gmw/en               (en 2)
 2  en-us           --/M      English_(America)  gmw/en-US            (en-r 5)(en 3)
 5  de              --/M      German             gmw/de
 5  fr-fr           --/M      French_(France)    roa/fr               (fr 5)
`;

describe("the voices the box can speak with", () => {
  it("reads espeak-ng's own list", () => {
    const v = parseEspeakVoices(VOICES);
    expect(v.map((x) => x.id)).toEqual(["af", "cmn", "en-gb", "en-us", "de", "fr-fr"]);
    expect(v.find((x) => x.id === "cmn")).toMatchObject({ name: "Chinese (Mandarin, latin as English)", file: "sit/cmn", gender: "male" });
    expect(v.find((x) => x.id === "en-us")!.name).toBe("English (America)");
  });

  it("does not take the header, or a blank line, for a voice", () => {
    expect(parseEspeakVoices("Pty Language Age/Gender VoiceName File\n\n")).toEqual([]);
  });

  it("asks espeak-ng, and says so when it cannot", async () => {
    expect((await listTtsVoices(async () => ({ code: 0, stdout: VOICES, stderr: "" }))).length).toBe(6);
    await expect(listTtsVoices(async () => ({ code: 127, stdout: "", stderr: "espeak-ng: not found" }))).rejects.toThrow(/espeak-ng --voices failed: espeak-ng: not found/);
  });

  it("offers a dozen timbres and the effects — thousands of combinations with the voices", () => {
    const ids = TTS_VARIANTS.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["", "m1", "m7", "f1", "f5", "croak", "whisper"]));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a voice choice from outside", () => {
  it("accepts a voice, a variant, a speed and a pitch", () => {
    expect(validateTtsChoice({ voice: "en-us+f3", speed: 140, pitch: 70 })).toEqual({ ok: true, choice: { voice: "en-us+f3", speed: 140, pitch: 70 } });
    expect(validateTtsChoice({})).toEqual({ ok: true, choice: {} });
    expect(validateTtsChoice({ voice: "" })).toEqual({ ok: true, choice: {} });
  });

  it("refuses anything that could be a different command", () => {
    for (const voice of ["en us", "en-us; reboot", "$(id)", "-v", "../x", "a".repeat(40), "en-us+f3+m1"]) {
      expect(validateTtsChoice({ voice }), voice).toMatchObject({ ok: false });
    }
  });

  it("keeps speed and pitch to what espeak-ng can do", () => {
    expect(validateTtsChoice({ speed: 79 })).toMatchObject({ ok: false });
    expect(validateTtsChoice({ speed: 451 })).toMatchObject({ ok: false });
    expect(validateTtsChoice({ pitch: 100 })).toMatchObject({ ok: false });
    expect(validateTtsChoice({ pitch: "high" })).toMatchObject({ ok: false });
    expect(validateTtsChoice("en")).toMatchObject({ ok: false });
  });

  it("builds the command line with the text after --", () => {
    expect(espeakArgs({}, "hi")).toEqual(["--", "hi"]);
    expect(espeakArgs({ voice: "cmn", speed: 150, pitch: 40 }, "--stdout")).toEqual(["-v", "cmn", "-s", "150", "-p", "40", "--", "--stdout"]);
  });
});

describe("what the ring is showing, for another process to read", () => {
  const innerRing = (): StatusRing & { shown: RingState[] } => {
    const shown: RingState[] = [];
    return { shown, show: async (s) => { shown.push(s); }, off: async () => { shown.push("off"); } };
  };

  it("records each state it is told, and passes it on", async () => {
    const written: string[] = [];
    const inner = innerRing();
    const ring = withStateFile(inner, { path: "/run/x.json", pid: 42, now: () => 1_000, write: async (_p, t) => { written.push(t); } });
    await ring.show("thinking");
    await ring.off();
    expect(inner.shown).toEqual(["thinking", "off"]);
    expect(written.map((w) => JSON.parse(w))).toEqual([{ state: "thinking", at: 1_000, pid: 42 }, { state: "off", at: 1_000, pid: 42 }]);
  });

  it("never lets a file it cannot write stop the lights", async () => {
    const ring = withStateFile(innerRing(), { write: async () => { throw new Error("read-only file system"); } });
    await expect(ring.show("verified")).resolves.toBeUndefined();
  });

  it("does not record a state the ring itself failed to show", async () => {
    const written: string[] = [];
    const broken: StatusRing = { show: async () => { throw new Error("GPIO5"); }, off: async () => {} };
    await expect(withStateFile(broken, { write: async (_p, t) => { written.push(t); } }).show("failed")).rejects.toThrow("GPIO5");
    expect(written).toEqual([]);
  });

  it("reads back a state a live process wrote", async () => {
    const read = async () => JSON.stringify({ state: "hearing", at: 5_000, pid: 7 });
    expect(await readRingState({ read, now: () => 6_000, alive: () => true })).toEqual({ state: "hearing", at: 5_000, pid: 7 });
  });

  it("believes nothing left behind: a dead process, an old file, junk, or no file", async () => {
    const old = async () => JSON.stringify({ state: "thinking", at: 0, pid: 7 });
    const day = 24 * 3_600_000;
    expect((await readRingState({ read: old, now: () => day, alive: () => true })).state).toBe("off");
    const fresh = async () => JSON.stringify({ state: "thinking", at: 5_000, pid: 7 });
    expect((await readRingState({ read: fresh, now: () => 6_000, alive: () => false })).state).toBe("off");
    expect((await readRingState({ read: async () => "{not json", now: () => 1 })).state).toBe("off");
    expect((await readRingState({ read: async () => JSON.stringify({ state: "sparkle", at: 1, pid: 1 }), now: () => 2, alive: () => true })).state).toBe("off");
    expect((await readRingState({ read: async () => { throw new Error("ENOENT"); } })).state).toBe("off");
  });

  it("keeps its file on the runtime tmpfs when there is one, so animation never wears the SD card", () => {
    expect(ringStatePath({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/hearth-ring-state.json");
    expect(ringStatePath({})).toBe("/tmp/hearth-ring-state.json");
  });
});
