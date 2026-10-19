import { describe, expect, it } from "vitest";
import { createKwsDetector } from "./kws.js";
import type { Spawner, SpawnedProcess } from "./process.js";

/**
 * The helper's protocol, as `tools/kws/hearth_kws.py` printed it on the Pi 3B (2026-10-19): one JSON object per line,
 * `ready` once the model is loaded, `keyword` on a detection, `error` before a non-zero exit. The Python itself is not
 * run here — it needs a model and a library this machine has no business having — so the process is scripted.
 */
const READY = JSON.stringify({ event: "ready", keywords: ["HEARTH"], model: "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20", chunk: "16", threshold: 0.25, score: 1.0 });
const HIT = JSON.stringify({ event: "keyword", keyword: "HEARTH", atSample: 59200 });

function scripted() {
  const lines: Array<(l: string) => void> = [];
  let end!: () => void;
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const written: Uint8Array[] = [];
  let exitCode: number | null | undefined;
  let resolveExit!: (c: number | null) => void;
  const exit = new Promise<number | null>((r) => { resolveExit = r; });
  const spawned: Array<{ cmd: string; args: string[]; stdin?: string | undefined }> = [];
  let killed = false, inputEnded = false;
  const proc: SpawnedProcess = {
    stdout: (async function* () {
      for (;;) {
        while (queue.length) yield new TextEncoder().encode(queue.shift()!);
        if (ended) return;
        await new Promise<void>((r) => { wake = r; });
      }
    })(),
    stderr: () => "ModuleNotFoundError: No module named 'sherpa_onnx'",
    write: (c) => { written.push(c); return true; },
    endInput: () => { inputEnded = true; },
    kill: () => { killed = true; ended = true; wake?.(); resolveExit(null); },
    exit,
  };
  const spawn: Spawner = (cmd, args, opts) => { spawned.push({ cmd, args, stdin: opts?.stdin }); return proc; };
  void lines; void end; void exitCode;
  return {
    spawn, spawned, written,
    say(line: string) { queue.push(line + "\n"); wake?.(); },
    die(code: number) { ended = true; wake?.(); resolveExit(code); },
    get killed() { return killed; }, get inputEnded() { return inputEnded; },
  };
}

const OPTS = { python: "/home/pi/kws/venv/bin/python", script: "/home/pi/hearth/tools/kws/hearth_kws.py", modelDir: "/home/pi/kws/model", keywords: ["hearth"] };
const chunk = (n = 3200) => new Uint8Array(n);
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("wake-word detector (keyword spotter helper)", () => {
  it("starts the helper with its model and words, with a pipe for audio, and is ready when the helper says so", async () => {
    const h = scripted();
    const kws = createKwsDetector({ ...OPTS, threshold: 0.25, chunk: 16, spawn: h.spawn });
    const loading = kws.load!();
    h.say(READY);
    await loading;
    expect(h.spawned[0]).toMatchObject({ cmd: OPTS.python, stdin: "pipe" });
    expect(h.spawned[0]!.args).toEqual([OPTS.script, "--model-dir", OPTS.modelDir, "--keyword", "hearth", "--threshold", "0.25", "--chunk", "16"]);
    expect(kws.name).toBe("kws:hearth");
    expect(kws.preRollMs).toBe(800);
  });

  it("feeds every chunk to the helper and fires on the chunk after the helper reports a detection, exactly once", async () => {
    const h = scripted();
    const kws = createKwsDetector({ ...OPTS, spawn: h.spawn });
    const loading = kws.load!(); h.say(READY); await loading;

    expect(kws.accept(chunk())).toBe(false);
    expect(kws.accept(chunk())).toBe(false);
    h.say(HIT); await tick();
    expect(kws.accept(chunk())).toBe(true);                 // the next chunk after the line arrived
    expect(kws.accept(chunk())).toBe(false);                // one detection, one wake
    expect(h.written).toHaveLength(4);                      // all of them reached the helper
    expect(kws.detections).toBe(1);
  });

  it("does not buffer audio from before the model was up — it would arrive late and be heard as if it were now", async () => {
    const h = scripted();
    const kws = createKwsDetector({ ...OPTS, spawn: h.spawn });
    const loading = kws.load!();
    expect(kws.accept(chunk())).toBe(false);
    expect(h.written).toHaveLength(0);
    expect(kws.dropped).toBe(1);
    h.say(READY); await loading;
    kws.accept(chunk());
    expect(h.written).toHaveLength(1);
  });

  it("reset drops a detection nobody asked about", async () => {
    const h = scripted();
    const kws = createKwsDetector({ ...OPTS, spawn: h.spawn });
    const loading = kws.load!(); h.say(READY); await loading;
    h.say(HIT); await tick();
    kws.reset();
    expect(kws.accept(chunk())).toBe(false);
  });

  it("ignores lines that are not the protocol (a library's stray message) instead of dying on them", async () => {
    const h = scripted();
    const events: unknown[] = [];
    const kws = createKwsDetector({ ...OPTS, spawn: h.spawn, onEvent: (e) => events.push(e) });
    const loading = kws.load!();
    h.say("OMP: Warning #96: Cannot form a team"); h.say("{broken"); h.say(READY);
    await loading;
    expect(events).toHaveLength(1);
  });

  it("a helper that cannot load says why, and load fails — the box does not listen deaf", async () => {
    const h = scripted();
    const kws = createKwsDetector({ ...OPTS, spawn: h.spawn });
    const loading = kws.load!();
    h.say(JSON.stringify({ event: "error", message: "missing Python package: No module named 'sherpa_onnx'" }));
    await expect(loading).rejects.toThrow(/wake-word detector: missing Python package/);
    expect(h.killed).toBe(true);
  });

  it("a helper that dies before it is ready fails load with its own stderr", async () => {
    const h = scripted();
    const loading = createKwsDetector({ ...OPTS, spawn: h.spawn }).load!();
    h.die(1);
    await expect(loading).rejects.toThrow(/exited \(code 1\).*No module named 'sherpa_onnx'/);
  });

  it("a helper that dies while listening makes the next chunk throw, because a detector that stopped looks exactly like a quiet room", async () => {
    const h = scripted();
    const kws = createKwsDetector({ ...OPTS, spawn: h.spawn });
    const loading = kws.load!(); h.say(READY); await loading;
    h.die(137); await tick();
    expect(() => kws.accept(chunk())).toThrow(/wake-word detector exited \(code 137\)/);
  });

  it("gives up if the model never loads", async () => {
    const h = scripted();
    await expect(createKwsDetector({ ...OPTS, spawn: h.spawn, loadTimeoutMs: 20 }).load!()).rejects.toThrow(/did not load within/);
    expect(h.killed).toBe(true);
  });

  it("close ends the helper's input and stops it; a closed detector never fires and never throws", async () => {
    const h = scripted();
    const kws = createKwsDetector({ ...OPTS, spawn: h.spawn });
    const loading = kws.load!(); h.say(READY); await loading;
    await kws.close!();
    expect(h.inputEnded).toBe(true);
    expect(h.killed).toBe(true);
    expect(kws.accept(chunk())).toBe(false);
  });
});
