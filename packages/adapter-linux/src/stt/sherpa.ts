/**
 * sherpa-onnx as a speech-to-text backend, over its websocket server.
 *
 * Why a server and not an addon: this repo carries no runtime dependencies, and
 * `sherpa-onnx-online-websocket-server` ships in the prebuilt aarch64 release.
 * Why a *long-lived* server: on a Pi 3B the model takes ~20 s to load
 * (2026-10-06, small bilingual zipformer, int8) and ~105 MB resident, which is
 * fine once and unusable per utterance.
 *
 * The wire protocol, as observed against v1.13.8 rather than assumed: the client
 * sends binary frames of little-endian float32 samples at the model's rate, then
 * the text `Done`. The server answers with JSON text frames, one per decoded
 * chunk — `{ text, segment, is_final, … }` — where `text` is the current
 * *segment* so far and `segment` increments each time the server's own
 * endpointing fires — and that same endpointing sets `is_final: true` on the
 * segment it closes, mid-utterance, so `is_final` does not mean the stream is
 * over. After `Done` the server decodes the tail, sends a last JSON frame and
 * then the text frame `Done!`; that frame, and only that, ends the utterance.
 * So an utterance's text is its segments joined, not the last frame.
 */
import { readFileSync } from "node:fs";
import { readdir as fsReaddir } from "node:fs/promises";
import { posix } from "node:path";
const { basename, join } = posix;   // this adapter drives Linux; paths are POSIX even if a test runs elsewhere
import type { SpeechToTextEngine, SttResult, SttSession } from "@hearthkit/edge-voice";
import { systemSpawner, type Spawner } from "./process.js";

/** The slice of the WHATWG WebSocket this needs, so a test can stand in for a server. */
export interface WebSocketLike {
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string | ArrayBufferView): void;
  close(): void;
}

export interface SherpaServerCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SherpaSttOptions {
  /** Where the server listens. */
  url?: string;
  /** Model name for logs and Transcripts' backend label. */
  model: string;
  /** Launch the server ourselves. Omit to use one that is already running. */
  server?: SherpaServerCommand;
  /** How long to wait for a launched server to accept connections. Default 90 s. */
  startTimeoutMs?: number;
  /** How long `finish()` waits for the closing frame. Default 8 s. */
  finishTimeoutMs?: number;
  spawn?: Spawner;
  connect?: (url: string) => WebSocketLike;
  /** Poll interval while waiting for the server; injected so tests need not wait. */
  pollMs?: number;
}

const defaultConnect = (url: string): WebSocketLike => {
  if (typeof WebSocket === "undefined") {
    throw new Error("this Node has no global WebSocket (needs Node 22+); cannot reach the sherpa-onnx server");
  }
  return new WebSocket(url) as unknown as WebSocketLike;
};

/** Open a socket, or say why it could not be. */
function open(connect: (u: string) => WebSocketLike, url: string, timeoutMs: number): Promise<WebSocketLike> {
  return new Promise((resolve, reject) => {
    let ws: WebSocketLike;
    try { ws = connect(url); } catch (e) { reject(e); return; }
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => { ws.close(); reject(new Error(`no answer from ${url} in ${timeoutMs} ms`)); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot connect to the sherpa-onnx server at ${url}`)); };
    ws.onclose = () => { clearTimeout(timer); reject(new Error(`the sherpa-onnx server at ${url} closed the connection`)); };
  });
}

/** Segments are joined with a space only where two words would otherwise run together. */
export function joinSegments(parts: string[]): string {
  let out = "";
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    out += out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(p) ? ` ${p}` : p;
  }
  return out;
}

export function createSherpaStt(o: SherpaSttOptions): SpeechToTextEngine {
  const url = o.url ?? "ws://127.0.0.1:6006";
  const spawn = o.spawn ?? systemSpawner;
  const connect = o.connect ?? defaultConnect;
  const finishTimeoutMs = o.finishTimeoutMs ?? 8_000;
  let server: ReturnType<Spawner> | undefined;

  const waitForServer = async (): Promise<void> => {
    const deadline = Date.now() + (o.startTimeoutMs ?? 90_000);
    let exited: number | null | undefined;
    void server?.exit.then((c) => { exited = c; });
    for (;;) {
      try {
        (await open(connect, url, 2_000)).close();
        return;
      } catch (err) {
        if (exited !== undefined) {
          throw new Error(`sherpa-onnx server exited (${exited ?? "not started"}): ${server?.stderr().trim().slice(-400) || "no output"}`);
        }
        if (Date.now() >= deadline) throw new Error(`sherpa-onnx server did not come up: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
      }
    }
  };

  return {
    backend: "sherpa",
    model: o.model,
    streaming: true,

    rssMb() {
      // The model lives in the server's process, not ours; /proc says how big it is. Only
      // known for a server this engine launched — an external one has no pid we can see.
      if (!server?.pid) return undefined;
      try {
        const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${server.pid}/status`, "utf8"))?.[1];
        return kb ? Math.round(Number(kb) / 1024) : undefined;
      } catch { return undefined; }
    },

    async load() {
      if (o.server) {
        server = spawn(o.server.command, o.server.args, { stdout: "ignore", ...(o.server.env ? { env: o.server.env } : {}) });
        await waitForServer().catch((e) => { server?.kill(); server = undefined; throw e; });
        return;
      }
      try {
        (await open(connect, url, 2_000)).close();
      } catch {
        throw new Error(
          `no sherpa-onnx server at ${url}. Start sherpa-onnx-online-websocket-server, or give Hearth the ` +
          "binary and model directory (HEARTH_STT_MODEL_PATH) so it can start one.",
        );
      }
    },

    async start(): Promise<SttSession> {
      const ws = await open(connect, url, 5_000);
      const segments = new Map<number, string>();
      let reported = "";
      let finished = false;
      let closedEarly = false;
      let waiter: (() => void) | undefined;

      const text = (): string => joinSegments([...segments.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t));
      const settle = (): void => { finished = true; waiter?.(); };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        if (ev.data.startsWith("Done")) { settle(); return; }
        try {
          const m = JSON.parse(ev.data) as { text?: unknown; segment?: unknown };
          if (typeof m.text === "string" && typeof m.segment === "number") segments.set(m.segment, m.text);
          // `is_final` is NOT the end of the stream: the server's endpointing sets it on a segment
          // mid-utterance too (seen on the Pi, 2026-10-06). Only `Done!` ends it.
        } catch { /* a frame that is not JSON carries nothing we can use */ }
      };
      ws.onclose = () => { closedEarly = !finished; waiter?.(); };
      ws.onerror = () => { closedEarly = !finished; waiter?.(); };

      return {
        async push(chunk): Promise<SttResult[]> {
          if (closedEarly) throw new Error("the sherpa-onnx server closed the connection mid-utterance");
          const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength - (chunk.byteLength % 2));
          const f32 = new Float32Array(view.byteLength / 2);
          for (let i = 0; i < f32.length; i++) f32[i] = view.getInt16(i * 2, true) / 32768;
          ws.send(f32);
          const now = text();
          if (now && now !== reported) { reported = now; return [{ text: now, isFinal: false, confidence: null }]; }
          return [];
        },

        async finish(): Promise<SttResult> {
          if (!finished) {
            if (closedEarly) throw new Error("the sherpa-onnx server closed the connection before the utterance ended");
            ws.send("Done");
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error(`the sherpa-onnx server did not finish within ${finishTimeoutMs} ms`)),
                finishTimeoutMs,
              );
              waiter = () => { clearTimeout(timer); resolve(); };
              if (finished || closedEarly) waiter();
            });
          }
          ws.close();
          if (!finished) throw new Error("the sherpa-onnx server closed the connection before the utterance ended");
          // No language is claimed: a bilingual model does not say which one it heard.
          return { text: text(), isFinal: true, confidence: null };
        },

        async abort() { ws.close(); },
      };
    },

    async close() {
      server?.kill();
      server = undefined;
    },
  };
}

/**
 * The command that starts the server for a transducer model directory.
 *
 * Prefers the int8 files — on a Cortex-A53 they are the ones that fit the time
 * budget — and falls back to fp32 only if int8 is absent. Reads the directory
 * rather than hard-coding `epoch-99-avg-1`, because that suffix is a property of
 * one release of one model.
 */
export async function sherpaServerCommand(o: {
  /** The unpacked release, containing `bin/` and `lib/`. */
  releaseDir: string;
  modelDir: string;
  port?: number;
  threads?: number;
  readdir?: (dir: string) => Promise<string[]>;
}): Promise<SherpaServerCommand> {
  const ls = o.readdir ?? fsReaddir;
  const files = await ls(o.modelDir);
  const pick = (prefix: string): string => {
    const ours = files.filter((f) => f.startsWith(prefix) && f.endsWith(".onnx"));
    const chosen = ours.find((f) => f.includes("int8")) ?? ours[0];
    if (!chosen) throw new Error(`no ${prefix}*.onnx in ${o.modelDir} — is this a transducer model directory?`);
    return join(o.modelDir, chosen);
  };
  if (!files.includes("tokens.txt")) throw new Error(`no tokens.txt in ${o.modelDir}`);
  return {
    command: join(o.releaseDir, "bin", "sherpa-onnx-online-websocket-server"),
    args: [
      `--port=${o.port ?? 6006}`,
      "--num-work-threads=1",
      "--num-io-threads=1",
      `--num-threads=${o.threads ?? 2}`,
      "--enable-endpoint=true",
      `--tokens=${join(o.modelDir, "tokens.txt")}`,
      `--encoder=${pick("encoder")}`,
      `--decoder=${pick("decoder")}`,
      `--joiner=${pick("joiner")}`,
    ],
    env: { LD_LIBRARY_PATH: join(o.releaseDir, "lib") },
  };
}

/** A short label for logs: the model directory's name. */
export const modelLabel = (modelDir: string): string => basename(modelDir.replace(/\/+$/, ""));
