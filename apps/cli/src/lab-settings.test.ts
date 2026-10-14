import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { RING_COLOURS, type AudioLab, type RingStateRecord, type TtsVoice } from "@hearthkit/adapter-linux";
import { parseArgs } from "./args.js";
import { configAsEnv, type HearthConfig } from "./config.js";
import { AVATAR_CSS, AVATAR_IDS, AVATAR_JS, isAvatarId } from "./lab-avatars.js";
import { createLab } from "./lab.js";

const VOICES: TtsVoice[] = [
  { id: "en-us", name: "English (America)", gender: "male", file: "gmw/en-US" },
  { id: "cmn", name: "Chinese (Mandarin, latin as English)", gender: "male", file: "sit/cmn" },
];

function memorySettings(initial: HearthConfig = {}) {
  let config: HearthConfig = { ...initial };
  return { get: () => config, load: async () => ({ ...config }), save: async (c: HearthConfig) => { config = { ...c }; } };
}

function recordingAudio(): AudioLab & { said: unknown[] } {
  const said: unknown[] = [];
  return {
    said, last: () => undefined,
    record: async () => ({ ok: true, cmdline: "arecord" }), play: async () => ({ ok: true, cmdline: "aplay" }),
    say: async (_t, choice) => { said.push(choice); return { ok: true, cmdline: "espeak-ng" }; },
  };
}

async function started(extra: Partial<Parameters<typeof createLab>[0]> = {}) {
  const settings = memorySettings();
  const audio = recordingAudio();
  const lab = createLab({
    token: "t", settings, audio, voices: async () => VOICES, throttled: async () => "0x0",
    cec: { device: "/dev/cec0", run: async () => ({ code: 0, stdout: "", stderr: "" }) }, ...extra,
  });
  const port = await lab.listen(0);
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}${p.includes("?") ? "&" : "?"}t=t`);
  const post = (p: string, body: unknown) => fetch(`http://127.0.0.1:${port}${p}?t=t`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { lab, settings, audio, get, post, port };
}

describe("the lab page", () => {
  it("is script that parses — the page has no build step, so nothing else would have caught a typo in it", async () => {
    const t = await started();
    const html = await (await t.get("/")).text();
    const js = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    expect(() => new Script(js)).not.toThrow();
    await t.lab.close();
  });

  it("has the Avatar and Voice tabs and the pieces they use", async () => {
    const t = await started();
    const html = await (await t.get("/")).text();
    for (const id of ['data-tab="avatar"', 'data-tab="voice"', 'id="faces"', 'id="avatarBig"', 'id="headAvatar"', 'id="vLang"', 'id="vVar"', 'id="vSpeed"', 'id="vPitch"', 'id="vSave"']) {
      expect(html, id).toContain(id);
    }
    await t.lab.close();
  });
});

describe("the avatars", () => {
  it("has a face for every id, and the ids are what the server accepts", () => {
    for (const id of AVATAR_IDS) {
      expect(AVATAR_JS, id).toContain(`${id}: { name:`);
      expect(isAvatarId(id)).toBe(true);
    }
    expect(isAvatarId("dragon")).toBe(false);
    expect(isAvatarId(undefined)).toBe(false);
  });

  it("has an expression for every state the ring can be in — the face and the ring are one fact", () => {
    for (const state of [...Object.keys(RING_COLOURS), "off"]) {
      expect(AVATAR_CSS, state).toContain(`data-state="${state}"`);
    }
  });

  it("uses the ring's colours for its halo", () => {
    const hex = (rgb: readonly number[]) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
    for (const state of ["loading", "hearing", "recognizing", "thinking", "acting", "speaking", "verified", "unverified", "unsupported", "failed"] as const) {
      expect(AVATAR_CSS.toLowerCase(), state).toContain(`[data-state="${state}"] { --halo:${hex(RING_COLOURS[state])}`);
    }
  });
});

describe("saving a face and a voice", () => {
  it("starts on the orb with no voice chosen", async () => {
    const t = await started();
    expect(await (await t.get("/api/settings")).json()).toMatchObject({ avatar: "orb", tts: { voice: null, speed: null, pitch: null } });
    await t.lab.close();
  });

  it("remembers the face in the Hearth config", async () => {
    const t = await started();
    expect((await t.post("/api/settings", { avatar: "fox" })).status).toBe(200);
    expect(t.settings.get().avatar).toBe("fox");
    expect(await (await t.get("/api/settings")).json()).toMatchObject({ avatar: "fox" });
    await t.lab.close();
  });

  it("refuses a face it does not have", async () => {
    const t = await started();
    expect((await t.post("/api/settings", { avatar: "../../etc/passwd" })).status).toBe(400);
    expect(t.settings.get().avatar).toBeUndefined();
    await t.lab.close();
  });

  it("remembers the voice, speed and pitch, and clears them on an empty choice", async () => {
    const t = await started();
    await t.post("/api/settings", { tts: { voice: "cmn+f3", speed: 150, pitch: 60 } });
    expect(t.settings.get()).toMatchObject({ ttsVoice: "cmn+f3", ttsSpeed: 150, ttsPitch: 60 });
    await t.post("/api/settings", { tts: {} });
    expect(t.settings.get().ttsVoice).toBeUndefined();
    expect(t.settings.get().ttsSpeed).toBeUndefined();
    expect(t.settings.get().ttsPitch).toBeUndefined();
    await t.lab.close();
  });

  it("refuses a voice that could be a command, and saves nothing", async () => {
    const t = await started();
    expect((await t.post("/api/settings", { tts: { voice: "en-us; reboot" } })).status).toBe(400);
    expect((await t.post("/api/settings", { tts: { speed: 5_000 } })).status).toBe(400);
    expect(t.settings.get().ttsVoice).toBeUndefined();
    await t.lab.close();
  });

  it("keeps the rest of the config when it saves", async () => {
    const settings = memorySettings({ platform: "linux", wakeWord: "hearth", leds: true });
    const t = await started({ settings });
    await t.post("/api/settings", { avatar: "owl" });
    expect(settings.get()).toMatchObject({ platform: "linux", wakeWord: "hearth", leds: true, avatar: "owl" });
    await t.lab.close();
  });

  it("is what the next `hearth` reads: the config becomes HEARTH_TTS_* and parses back", () => {
    const env = configAsEnv({ ttsVoice: "en-gb+m3", ttsSpeed: 140, ttsPitch: 35, avatar: "cat" });
    expect(env).toMatchObject({ HEARTH_TTS_VOICE: "en-gb+m3", HEARTH_TTS_SPEED: "140", HEARTH_TTS_PITCH: "35", HEARTH_AVATAR: "cat" });
    expect(parseArgs([], env)).toMatchObject({ ttsVoice: "en-gb+m3", ttsSpeed: 140, ttsPitch: 35 });
  });
});

describe("the voices", () => {
  it("lists what espeak-ng offers, with the timbres to combine them with", async () => {
    const t = await started();
    const d = await (await t.get("/api/voices")).json() as { voices: TtsVoice[]; variants: Array<{ id: string }> };
    expect(d.voices.map((v) => v.id)).toEqual(["en-us", "cmn"]);
    expect(d.variants.map((v) => v.id)).toEqual(expect.arrayContaining(["", "m3", "f2", "whisper"]));
    await t.lab.close();
  });

  it("says why when it cannot list them, instead of an empty page that looks like no voices exist", async () => {
    const t = await started({ voices: async () => { throw new Error("espeak-ng --voices failed: not found"); } });
    const d = await (await t.get("/api/voices")).json() as { voices: unknown[]; error: string };
    expect(d.voices).toEqual([]);
    expect(d.error).toMatch(/not found/);
    await t.lab.close();
  });

  it("speaks with the voice, speed and pitch the page sends", async () => {
    const t = await started();
    await t.post("/api/audio/say", { text: "hello", voice: "en-us+f3", speed: 140, pitch: 70 });
    expect(t.audio.said).toEqual([{ voice: "en-us+f3", speed: 140, pitch: 70 }]);
    await t.lab.close();
  });
});

describe("the avatar follows the real ring", () => {
  it("streams each change of the ring's state, once, and the current one first", async () => {
    const seq: RingStateRecord[] = [
      { state: "off", at: 1, pid: 1 }, { state: "hearing", at: 2, pid: 2 }, { state: "hearing", at: 3, pid: 2 }, { state: "thinking", at: 4, pid: 2 },
    ];
    let i = 0;
    const t = await started({ pollMs: 5, ringState: async () => seq[Math.min(i++, seq.length - 1)]! });
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${t.port}/api/ring-stream?t=t`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    let text = "";
    const deadline = Date.now() + 2_000;
    while (!text.includes("thinking") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ctl.abort();
    const states = [...text.matchAll(/data: (\{.*\})/g)].map((m) => (JSON.parse(m[1]!) as RingStateRecord).state);
    expect(states).toEqual(["off", "hearing", "thinking"]);                 // "hearing" twice in a row is one event
    await t.lab.close();
  });

  it("answers the state once, for a page that only wants to know now", async () => {
    const t = await started({ ringState: async () => ({ state: "acting", at: 9, pid: 3 }) });
    expect(await (await t.get("/api/ring-state")).json()).toEqual({ state: "acting", at: 9, pid: 3 });
    await t.lab.close();
  });

  it("is behind the token like everything else", async () => {
    const t = await started();
    expect((await fetch(`http://127.0.0.1:${t.port}/api/settings`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${t.port}/api/ring-stream`)).status).toBe(403);
    await t.lab.close();
  });
});
