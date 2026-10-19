import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav } from "@hearthkit/edge-voice";
import { createLocalListener, type LocalListener } from "./local-listener.js";

/**
 * The claim that matters, tested end to end: **a hosted recogniser is only sent what was said after the wake word.**
 *
 * Everything between the microphone and the network is real here — the gated input, the pipeline, the voice detector, the
 * wake-word detector as a real child process speaking the real protocol, the transcriber engine, an HTTP upload — except the
 * two things that cannot be: the microphone is a WAV file played at its own pace, and the keyword model is a twenty-line
 * stand-in that fires (or never fires) on cue. The "recogniser" is a local HTTP server that counts what it is sent.
 */
const FORMAT = { sampleRate: 16_000, channels: 1 };

/** Silence, then a tone for `toneMs` (loud enough for the energy voice detector), then silence again. */
function wavFile(dir: string, o: { leadMs: number; toneMs: number; tailMs: number; level?: number }): string {
  const n = (ms: number) => Math.round((16_000 * ms) / 1000);
  const total = n(o.leadMs) + n(o.toneMs) + n(o.tailMs);
  const pcm = new Uint8Array(total * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < n(o.toneMs); i++) view.setInt16((n(o.leadMs) + i) * 2, Math.round(Math.sin(i / 6) * (o.level ?? 0.3) * 32767), true);
  const path = join(dir, "room.wav");
  writeFileSync(path, encodeWav(pcm, FORMAT));
  return path;
}

/** `tools/kws/hearth_kws.py`, in miniature: ready at once, then — if told to — one detection after `fireAfterBytes` of audio. */
function fakeHelper(dir: string, fireAfterMs: number | undefined): string {
  const path = join(dir, "fake-kws.mjs");
  writeFileSync(path, `
    const fireAt = ${fireAfterMs === undefined ? "Infinity" : Math.round((16_000 * 2 * fireAfterMs) / 1000)};
    let seen = 0, fired = false;
    console.log(JSON.stringify({ event: "ready", keywords: ["HEARTH"] }));
    process.stdin.on("data", (d) => {
      seen += d.length;
      if (!fired && seen >= fireAt) { fired = true; console.log(JSON.stringify({ event: "keyword", keyword: "HEARTH", atSample: seen / 2 })); }
    });
    process.stdin.on("end", () => process.exit(0));
  `);
  return path;
}

let server: Server | undefined;
let listener: LocalListener | undefined;
afterEach(async () => {
  await listener?.stop().catch(() => {});
  listener = undefined;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function recogniserServer(reply = "turn it down"): Promise<{ baseUrl: string; uploads: Array<{ bytes: number }> }> {
  const uploads: Array<{ bytes: number }> = [];
  server = createServer((req, res) => {
    let bytes = 0;
    req.on("data", (c: Buffer) => { bytes += c.length; });
    req.on("end", () => { uploads.push({ bytes }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ text: reply })); });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, uploads };
}

async function build(o: { fire: number | undefined; tone?: number; level?: number; reply?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "hearth-kws-e2e-"));
  const rec = await recogniserServer(o.reply);
  const errs: string[] = [];
  listener = await createLocalListener(
    { HEARTH_AUDIO_DEVICE: `file:${wavFile(dir, { leadMs: 500, toneMs: o.tone ?? 1_500, tailMs: 1_500, ...(o.level !== undefined ? { level: o.level } : {}) })}` },
    { err: (t) => { errs.push(t); } },
    {
      quiet: false,
      recogniser: { baseUrl: rec.baseUrl, apiKey: "test-key" },
      kws: { python: process.execPath, script: fakeHelper(dir, o.fire), modelDir: dir, keywords: ["hearth"], preRollMs: 800 },
    },
  );
  return { listener: listener!, rec, errs };
}

describe("a wake-word detector in front of a hosted recogniser", () => {
  it("uploads the utterance once the wake word has been heard, and hands the transcript to the loop as already addressed to us", async () => {
    const { listener: l, rec } = await build({ fire: 700 });
    expect(l.addressed).toBe(true);
    const text = await l.listener.listen();
    expect(text).toBe("turn it down");
    expect(rec.uploads).toHaveLength(1);
    expect(rec.uploads[0]!.bytes).toBeGreaterThan(30_000);       // a real recording, with its header, not a stub
  });

  it("sends NOTHING when the wake word is never heard — the room's sound does not leave the box", async () => {
    const { listener: l, rec, errs } = await build({ fire: undefined });
    // The file ends, which the pipeline reports as the microphone closing; what matters is what was uploaded by then.
    await expect(l.listener.listen()).rejects.toThrow(/pipeline ended/);
    expect(rec.uploads).toHaveLength(0);
    expect(errs.join("")).not.toMatch(/stt_result/);
  });

  // The voice detector keeps ~600 ms of trailing quiet with an utterance, so a blip that only just passed it is diluted below the
  // room's level by the time it is a recording. That recording is a cough or a door, not a command.
  it("holds back a recording that never rose above the room even after a detection, and says so", async () => {
    const { listener: l, rec, errs } = await build({ fire: 700, tone: 200, level: 0.02 });
    await expect(l.listener.listen()).rejects.toThrow(/pipeline ended/);
    expect(rec.uploads).toHaveLength(0);
    expect(errs.join("")).toMatch(/not sent: too-quiet/);
  });
});

describe("a recogniser with no detector (the old way)", () => {
  it("is not addressed: the loop still has to find the word in the transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-kws-e2e-"));
    const rec = await recogniserServer();
    listener = await createLocalListener(
      { HEARTH_AUDIO_DEVICE: `file:${wavFile(dir, { leadMs: 500, toneMs: 1_500, tailMs: 1_500 })}` },
      { err: () => {} },
      { quiet: true, recogniser: { baseUrl: rec.baseUrl } },
    );
    expect(listener.addressed).toBe(false);
    // Everything with sound in it is sent — which is exactly the cost the detector exists to remove.
    expect(await listener.listener.listen()).toBe("turn it down");
    expect(rec.uploads).toHaveLength(1);
  });
});
