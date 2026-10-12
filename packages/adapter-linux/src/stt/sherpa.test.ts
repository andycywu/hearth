import { describe, expect, it } from "vitest";
import { createSherpaStt, joinSegments, sherpaServerCommand, type WebSocketLike } from "./sherpa.js";
import type { SpawnedProcess } from "./process.js";

/**
 * The frames below are the ones sherpa-onnx v1.13.8's online websocket server
 * sent on the Pi 3B (2026-10-06) for the model's own `2.wav`, with the fields
 * this code does not read dropped. Order and values are the server's; the
 * texts are what the small bilingual zipformer made of that file.
 */
const frame = (text: string, segment: number, is_final = false) => JSON.stringify({ text, segment, is_final });
const REAL_FRAMES = [
  frame("这", 0), frame("这", 0), frame("这是", 0), frame("这是频繁", 0), frame("这是频繁", 0),
  frame("", 1), frame("", 1),
];
const CLOSING = [frame("", 1, true), "Done!"];

class FakeServerSocket implements WebSocketLike {
  binaryType = "blob";
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  sent: Array<string | ArrayBufferView> = [];
  closed = false;
  private framesPerPush: string[];
  private onDone: string[];
  constructor(o: { framesPerPush?: string[]; onDone?: string[]; refuse?: boolean; dieAfterPushes?: number }, private pushesBeforeDeath = o.dieAfterPushes) {
    this.framesPerPush = [...(o.framesPerPush ?? [])];
    this.onDone = o.onDone ?? CLOSING;
    queueMicrotask(() => (o.refuse ? this.onerror?.({}) : this.onopen?.({})));
  }
  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
    if (data === "Done") { for (const f of this.onDone) queueMicrotask(() => this.onmessage?.({ data: f })); return; }
    if (this.pushesBeforeDeath !== undefined && --this.pushesBeforeDeath < 0) { queueMicrotask(() => this.onclose?.({})); return; }
    const f = this.framesPerPush.shift();
    if (f !== undefined) queueMicrotask(() => this.onmessage?.({ data: f }));
  }
  close(): void { this.closed = true; }
}

const pcm16 = (samples: number[]): Uint8Array => {
  const out = new Uint8Array(samples.length * 2);
  const v = new DataView(out.buffer);
  samples.forEach((s, i) => v.setInt16(i * 2, s, true));
  return out;
};

describe("joinSegments", () => {
  it("runs Chinese together, separates words, and skips empty segments", () => {
    expect(joinSegments(["打开电视", "", "音量调到二十"])).toBe("打开电视音量调到二十");
    expect(joinSegments(["turn on", "the tv"])).toBe("turn on the tv");
    expect(joinSegments(["把", "NETFLIX", "打开"])).toBe("把NETFLIX打开");
  });
});

describe("sherpa STT over the websocket protocol", () => {
  it("streams float32 samples, reports partials, and finishes with the segments joined", async () => {
    const sock = new FakeServerSocket({ framesPerPush: REAL_FRAMES });
    const stt = createSherpaStt({ model: "m", connect: () => sock });
    const session = await stt.start();

    // The server answers each chunk a moment later, so a push reports what the
    // chunks *before* it produced: partials lag the audio by one chunk.
    const seen = [await session.push(pcm16([16384, -16384]))];
    for (let i = 0; i < 3; i++) seen.push(await session.push(pcm16([0, 0])));
    expect(seen.map((r) => r.map((x) => x.text))).toEqual([[], ["这"], [], ["这是"]]);
    expect(seen.flat().every((r) => !r.isFinal && r.confidence === null)).toBe(true);

    // The wire format: float32 little-endian, scaled to [-1, 1).
    expect(Array.from(sock.sent[0] as Float32Array)).toEqual([0.5, -0.5]);

    const final = await session.finish();
    expect(final).toEqual({ text: "这是频繁", isFinal: true, confidence: null });
    expect(sock.sent.at(-1)).toBe("Done");
    expect(sock.closed).toBe(true);
  });

  it("joins the text of every segment the server's endpointing produced", async () => {
    const sock = new FakeServerSocket({ framesPerPush: [frame("打开电视", 0), frame("音量调到二十", 1)], onDone: [frame("音量调到二十", 1, true), "Done!"] });
    const session = await createSherpaStt({ model: "m", connect: () => sock }).start();
    await session.push(pcm16([1, 2]));
    await session.push(pcm16([1, 2]));
    expect((await session.finish()).text).toBe("打开电视音量调到二十");
  });

  it("does not take a mid-utterance is_final for the end: it waits for Done! and keeps the later text", async () => {
    // Observed on the Pi: the server marks a segment final when its endpointing fires, then carries on.
    const sock = new FakeServerSocket({
      framesPerPush: [frame("打开电视", 0, true), frame("音量", 1)],
      onDone: [frame("音量调到二十", 1), frame("", 2, true), "Done!"],
    });
    const session = await createSherpaStt({ model: "m", connect: () => sock }).start();
    await session.push(pcm16([1, 2]));
    await session.push(pcm16([1, 2]));
    await new Promise((r) => setTimeout(r, 0));
    const final = await session.finish();
    expect(sock.sent.at(-1)).toBe("Done");                      // it did ask the server to finish
    expect(final.text).toBe("打开电视音量调到二十");              // and kept what arrived after the early is_final
  });

  it("never claims a language or a confidence", async () => {
    const sock = new FakeServerSocket({});
    const session = await createSherpaStt({ model: "m", connect: () => sock }).start();
    const r = await session.finish();
    expect(r.confidence).toBeNull();
    expect("language" in r).toBe(false);
  });

  it("fails start() when the server is not there", async () => {
    const stt = createSherpaStt({ model: "m", connect: () => new FakeServerSocket({ refuse: true }) });
    await expect(stt.start()).rejects.toThrow(/cannot connect to the sherpa-onnx server/);
  });

  it("says how to start a server when load() finds none", async () => {
    const stt = createSherpaStt({ model: "m", connect: () => new FakeServerSocket({ refuse: true }) });
    await expect(stt.load()).rejects.toThrow(/no sherpa-onnx server at ws:\/\/127\.0\.0\.1:6006/);
  });

  it("reports a server that dies mid-utterance rather than inventing a transcript", async () => {
    const sock = new FakeServerSocket({}, 1);
    const session = await createSherpaStt({ model: "m", connect: () => sock }).start();
    await session.push(pcm16([1, 2]));
    await session.push(pcm16([1, 2]));         // this one is where the server goes away
    await new Promise((r) => setTimeout(r, 0));
    await expect(session.finish()).rejects.toThrow(/closed the connection/);
  });

  it("times out when the closing frame never comes", async () => {
    const sock = new FakeServerSocket({ onDone: [] });
    const session = await createSherpaStt({ model: "m", connect: () => sock, finishTimeoutMs: 20 }).start();
    await expect(session.finish()).rejects.toThrow(/did not finish within 20 ms/);
  });
});

describe("launching the server", () => {
  const proc = (exit: Promise<number | null>, err = ""): SpawnedProcess & { killed: boolean } => {
    const p = { stdout: (async function* () { /* nothing */ })(), stderr: () => err, kill: () => { p.killed = true; }, exit, killed: false };
    return p;
  };

  it("waits until the server accepts connections, then is ready", async () => {
    let attempts = 0;
    const p = proc(new Promise(() => {}));
    const stt = createSherpaStt({
      model: "m", server: { command: "srv", args: [] }, pollMs: 1, spawn: () => p,
      connect: () => new FakeServerSocket({ refuse: ++attempts < 3 }),
    });
    await stt.load();
    expect(attempts).toBe(3);
    await stt.close();
    expect(p.killed).toBe(true);
  });

  it("reports the server's own stderr when it exits instead of starting", async () => {
    const p = proc(Promise.resolve(1), "Failed to open encoder model");
    const stt = createSherpaStt({
      model: "m", server: { command: "srv", args: [] }, pollMs: 1, spawn: () => p,
      connect: () => new FakeServerSocket({ refuse: true }),
    });
    await expect(stt.load()).rejects.toThrow(/exited \(1\).*Failed to open encoder model/);
  });

  it("gives up, and kills the server, when it never comes up", async () => {
    const p = proc(new Promise(() => {}));
    const stt = createSherpaStt({
      model: "m", server: { command: "srv", args: [] }, pollMs: 1, startTimeoutMs: 20, spawn: () => p,
      connect: () => new FakeServerSocket({ refuse: true }),
    });
    await expect(stt.load()).rejects.toThrow(/did not come up/);
    expect(p.killed).toBe(true);
  });
});

describe("sherpaServerCommand", () => {
  const files = [
    "bpe.model", "tokens.txt",
    "encoder-epoch-99-avg-1.onnx", "encoder-epoch-99-avg-1.int8.onnx",
    "decoder-epoch-99-avg-1.onnx", "decoder-epoch-99-avg-1.int8.onnx",
    "joiner-epoch-99-avg-1.onnx", "joiner-epoch-99-avg-1.int8.onnx",
  ];

  it("picks the int8 files and points the loader at the release's lib directory", async () => {
    const cmd = await sherpaServerCommand({ releaseDir: "/r", modelDir: "/m", readdir: async () => files });
    expect(cmd.command).toBe("/r/bin/sherpa-onnx-online-websocket-server");
    expect(cmd.args).toContain("--encoder=/m/encoder-epoch-99-avg-1.int8.onnx");
    expect(cmd.args).toContain("--joiner=/m/joiner-epoch-99-avg-1.int8.onnx");
    expect(cmd.env).toEqual({ LD_LIBRARY_PATH: "/r/lib" });
  });

  it("falls back to fp32 when there is no int8", async () => {
    const cmd = await sherpaServerCommand({ releaseDir: "/r", modelDir: "/m", readdir: async () => files.filter((f) => !f.includes("int8")) });
    expect(cmd.args).toContain("--decoder=/m/decoder-epoch-99-avg-1.onnx");
  });

  it("says what is missing from a directory that is not a transducer model", async () => {
    await expect(sherpaServerCommand({ releaseDir: "/r", modelDir: "/m", readdir: async () => ["tokens.txt"] })).rejects.toThrow(/no encoder/);
    await expect(sherpaServerCommand({ releaseDir: "/r", modelDir: "/m", readdir: async () => ["model.onnx"] })).rejects.toThrow(/no tokens.txt/);
  });
});
