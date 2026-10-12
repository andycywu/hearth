import { describe, expect, it } from "vitest";
import { createArecordInput } from "./arecord-input.js";
import type { SpawnedProcess, Spawner } from "./process.js";

const FORMAT = { sampleRate: 16_000, channels: 1 };

function scripted(chunks: number[][], o: { exit?: number | null; stderr?: string } = {}): { spawn: Spawner; calls: string[][]; killed: () => boolean } {
  const calls: string[][] = [];
  let killed = false;
  const spawn: Spawner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const p: SpawnedProcess = {
      stdout: (async function* () { for (const c of chunks) yield Uint8Array.from(c); })(),
      stderr: () => o.stderr ?? "",
      kill: () => { killed = true; },
      exit: Promise.resolve(o.exit === undefined ? 0 : o.exit),
    };
    return p;
  };
  return { spawn, calls, killed: () => killed };
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const c of it) out.push(Array.from(c));
  return out;
}

describe("arecord microphone input", () => {
  it("asks arecord for raw 16-bit mono at the model's rate, on the chosen device", async () => {
    const s = scripted([[1, 0]]);
    const input = createArecordInput({ device: "hw:2,0", format: FORMAT, spawn: s.spawn });
    const stream = input.open();
    await input.close();                    // closing first: a clean end, not a device fault
    await collect(stream);
    expect(s.calls[0]).toEqual(["arecord", "-D", "hw:2,0", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-q"]);
  });

  it("keeps every sample whole when a read ends on an odd byte", async () => {
    const s = scripted([[1, 0, 2], [0, 3, 0]]);
    const input = createArecordInput({ device: "default", format: FORMAT, spawn: s.spawn });
    const stream = input.open();
    const got: number[][] = [];
    const it = stream[Symbol.asyncIterator]();
    got.push(Array.from((await it.next()).value as Uint8Array));
    got.push(Array.from((await it.next()).value as Uint8Array));
    await input.close();
    expect(got).toEqual([[1, 0], [2, 0, 3, 0]]);
    expect(got.every((c) => c.length % 2 === 0)).toBe(true);
  });

  it("throws, with arecord's own words, when the device goes away", async () => {
    const s = scripted([[1, 0]], { exit: 1, stderr: "arecord: main:831: audio open error: Device or resource busy" });
    const input = createArecordInput({ device: "default", format: FORMAT, spawn: s.spawn });
    await expect(collect(input.open())).rejects.toThrow(/stopped capturing from "default": arecord: main:831: audio open error/);
  });

  it("says so when arecord cannot be started at all", async () => {
    const s = scripted([], { exit: null });
    const input = createArecordInput({ device: "default", format: FORMAT, spawn: s.spawn });
    await expect(collect(input.open())).rejects.toThrow(/could not be started/);
  });

  it("kills the process on close", async () => {
    const s = scripted([]);
    const input = createArecordInput({ device: "default", format: FORMAT, spawn: s.spawn });
    void input.open()[Symbol.asyncIterator]().next().catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    await input.close();
    expect(s.killed()).toBe(true);
  });
});
