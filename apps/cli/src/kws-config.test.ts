import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";
import { configAsEnv } from "./config.js";
import { kwsConfigAsEnv, kwsConfigFromEnv, kwsEnv, resolveKws } from "./kws-config.js";

const present = (...paths: string[]) => async (p: string) => paths.includes(p);
const ENV = { HEARTH_KWS_MODEL_PATH: "/home/pi/kws/model", HEARTH_KWS_SCRIPT: "/home/pi/hearth/tools/kws/hearth_kws.py", HEARTH_KWS_PYTHON: "/home/pi/kws/venv/bin/python" };
const BOTH = present("/home/pi/kws/model", "/home/pi/hearth/tools/kws/hearth_kws.py");

describe("finding the wake-word detector", () => {
  it("resolves to what would be started: the python, the script, the model, the word", async () => {
    const r = await resolveKws(ENV, "hearth", BOTH);
    expect(r).toEqual({ ok: true, settings: { python: "/home/pi/kws/venv/bin/python", script: ENV.HEARTH_KWS_SCRIPT, modelDir: ENV.HEARTH_KWS_MODEL_PATH, keywords: ["hearth"] } });
  });

  it("carries the tuning when it is set, and only then", async () => {
    const r = await resolveKws({ ...ENV, HEARTH_KWS_THRESHOLD: "0.3", HEARTH_KWS_SCORE: "1.5", HEARTH_KWS_CHUNK: "8", HEARTH_KWS_PREROLL_MS: "1000" }, "hearth", BOTH);
    expect(r).toMatchObject({ ok: true, settings: { threshold: 0.3, score: 1.5, chunk: 8, preRollMs: 1000 } });
    expect((await resolveKws(ENV, "hearth", BOTH) as { settings: object }).settings).not.toHaveProperty("threshold");
  });

  it("says which variable is missing, rather than starting something that cannot work", async () => {
    expect(await resolveKws({}, "hearth", BOTH)).toMatchObject({ ok: false, why: expect.stringContaining("HEARTH_KWS_MODEL_PATH is not set") });
    expect(await resolveKws(ENV, "hearth", present())).toMatchObject({ ok: false, why: expect.stringContaining("/home/pi/kws/model does not exist") });
    expect(await resolveKws(ENV, "hearth", present("/home/pi/kws/model"))).toMatchObject({ ok: false, why: expect.stringContaining("detector script") });
  });

  it("needs a wake word; takes English words and Chinese characters, several at once, and nothing else", async () => {
    expect(await resolveKws(ENV, undefined, BOTH)).toMatchObject({ ok: false, why: expect.stringContaining("needs a wake word") });
    expect(await resolveKws(ENV, "hey hearth", BOTH)).toMatchObject({ ok: true });
    expect(await resolveKws(ENV, "爐火精靈", BOTH)).toMatchObject({ ok: true, settings: { keywords: ["爐火精靈"] } });
    // One assistant, two names: both go to the spotter, which returns whichever it heard.
    expect(await resolveKws(ENV, "hearth,爐火精靈", BOTH)).toMatchObject({ ok: true, settings: { keywords: ["hearth", "爐火精靈"] } });
    expect(await resolveKws(ENV, "hearth， 爐火精靈", BOTH)).toMatchObject({ ok: true, settings: { keywords: ["hearth", "爐火精靈"] } });
    // A word the helper has no way to say to the model is refused by name, not passed on to fail at boot.
    expect(await resolveKws(ENV, "hearth,こんにちは", BOTH)).toMatchObject({ ok: false, why: expect.stringContaining('"こんにちは"') });
    expect(await resolveKws(ENV, "hearth 2", BOTH)).toMatchObject({ ok: false });
  });

  it("refuses a chunk size the model does not come in", async () => {
    expect(await resolveKws({ ...ENV, HEARTH_KWS_CHUNK: "32" }, "hearth", BOTH)).toMatchObject({ ok: false, why: expect.stringContaining("8 or 16") });
  });

  it("defaults the python to python3 and the script to the one in this checkout", async () => {
    const r = await resolveKws({ HEARTH_KWS_MODEL_PATH: "/m" }, "hearth", async () => true);
    expect(r).toMatchObject({ ok: true, settings: { python: "python3", script: expect.stringMatching(/tools[\\/]kws[\\/]hearth_kws\.py$/) } });
  });
});

describe("remembering the detector", () => {
  it("round-trips between what config.json stores and the environment the resolver reads", () => {
    const stored = kwsConfigFromEnv({ ...ENV, HEARTH_KWS_THRESHOLD: "0.3", HEARTH_KWS_CHUNK: "8" });
    expect(stored).toEqual({ modelPath: ENV.HEARTH_KWS_MODEL_PATH, python: ENV.HEARTH_KWS_PYTHON, script: ENV.HEARTH_KWS_SCRIPT, threshold: 0.3, chunk: 8 });
    expect(kwsConfigAsEnv(stored)).toEqual({ ...ENV, HEARTH_KWS_THRESHOLD: "0.3", HEARTH_KWS_CHUNK: "8" });
    expect(kwsConfigAsEnv(undefined)).toEqual({});
  });

  it("stands in for the environment underneath it: config < environment, like every other setting", () => {
    const opts = parseArgs(["hi"], { ...configAsEnv({ wakeDetector: "kws", kws: { modelPath: "/from/config" } }) });
    expect(opts.wakeDetector).toBe("kws");
    expect(configAsEnv({ kws: { modelPath: "/from/config" } }).HEARTH_KWS_MODEL_PATH).toBe("/from/config");
  });

  it("kwsEnv picks out only the detector's own variables", () => {
    expect(kwsEnv({ ...ENV, TV_AGENT_API_KEY: "sk-secret", HOME: "/home/pi" })).toEqual(ENV);
  });

  it("--wake-detector is validated and beats the environment and the config", () => {
    expect(parseArgs(["--wake-detector", "kws", "hi"]).wakeDetector).toBe("kws");
    expect(parseArgs(["--wake-detector=magic", "hi"]).errors[0]).toContain("kws or transcript");
    expect(parseArgs(["hi"], { HEARTH_WAKE_DETECTOR: "magic" }).warnings.join()).toContain("HEARTH_WAKE_DETECTOR");
    expect(parseArgs(["--wake-detector", "transcript", "hi"], configAsEnv({ wakeDetector: "kws" })).wakeDetector).toBe("transcript");
    expect(parseArgs(["hi"]).wakeDetector).toBeUndefined();
  });
});
