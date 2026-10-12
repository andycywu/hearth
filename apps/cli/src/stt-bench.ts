/**
 * `hearth stt bench <manifest.json>` — the same audio through the configured
 * engine, with expected and actual text, latency, real-time factor and memory.
 *
 * The manifest is data, and the recordings are not shipped: an item whose audio
 * file does not exist is reported as `missing_audio` rather than failing the
 * run, so the dataset can be filled in a few clips at a time. See
 * `bench/stt/README.md` for the format.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  parseWav, resolveEdgeVoiceConfig, runBenchmark, summarize, toCsv,
  type BenchItem, type EdgeVoiceConfig, type SpeechToTextEngine,
} from "@hearthkit/edge-voice";
import type { SttDeps } from "./stt.js";
import type { CliOptions } from "./args.js";

interface ManifestItem {
  id?: unknown; audio?: unknown; expected?: unknown; language?: unknown; tags?: unknown;
}

export interface BenchDeps extends SttDeps {
  /** Builds the engine; shared with `hearth stt`. */
  makeEngine: (config: EdgeVoiceConfig) => Promise<SpeechToTextEngine>;
}

export async function loadBenchItems(
  manifestPath: string,
  config: EdgeVoiceConfig,
  read: (path: string) => Promise<Uint8Array>,
): Promise<BenchItem[]> {
  let manifest: { items?: unknown };
  try {
    manifest = JSON.parse(new TextDecoder().decode(await read(manifestPath))) as { items?: unknown };
  } catch (err) {
    throw new Error(`cannot read manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(manifest.items)) throw new Error(`${manifestPath}: no "items" array`);

  const base = dirname(manifestPath);
  const seen = new Set<string>();
  const items: BenchItem[] = [];
  for (const [i, raw] of (manifest.items as ManifestItem[]).entries()) {
    const id = typeof raw.id === "string" && raw.id ? raw.id : undefined;
    if (!id || typeof raw.expected !== "string" || typeof raw.audio !== "string") {
      throw new Error(`${manifestPath}: item ${i} needs string "id", "audio" and "expected"`);
    }
    if (seen.has(id)) throw new Error(`${manifestPath}: duplicate id "${id}"`);
    seen.add(id);

    const item: BenchItem = {
      id, expected: raw.expected,
      language: typeof raw.language === "string" ? raw.language : undefined,
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : undefined,
    };
    let bytes: Uint8Array | undefined;
    try { bytes = await read(resolve(base, raw.audio)); } catch (err) {
      // A recording that has not been made yet is the normal state of a young dataset.
      if ((err as { code?: string }).code !== "ENOENT") item.error = `cannot read ${raw.audio}: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (bytes) {
      try {
        const wav = parseWav(bytes);
        if (wav.format.sampleRate !== config.sampleRate || wav.format.channels !== config.channels) {
          item.error = `${raw.audio} is ${wav.format.sampleRate} Hz × ${wav.format.channels}ch; ` +
            `the pipeline is configured for ${config.sampleRate} Hz × ${config.channels}ch and does not resample`;
        } else {
          item.audio = { pcm: wav.pcm, format: wav.format };
        }
      } catch (err) {
        item.error = `${raw.audio}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    items.push(item);
  }
  return items;
}

export async function runSttBench(opts: CliOptions, manifestPath: string, deps: BenchDeps): Promise<number> {
  const { io } = deps;
  const { config, warnings } = resolveEdgeVoiceConfig(deps.env);
  for (const w of warnings) io.err(`hearth: ${w}\n`);

  let items: BenchItem[];
  let engine: SpeechToTextEngine;
  try {
    items = await loadBenchItems(manifestPath, config, deps.readFile ?? (async (p) => new Uint8Array(await readFile(p))));
    engine = await deps.makeEngine(config);
  } catch (err) {
    io.err(`hearth: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let results;
  try {
    results = await runBenchmark({
      engine, items, realtime: opts.realtime,
      ...(deps.rssMb ? { rssMb: deps.rssMb } : {}),
      onResult: (r) => {
        if (!opts.quiet) io.err(`  ${r.status === "ok" ? "✓" : r.status === "missing_audio" ? "·" : "✗"} ${r.id}${r.status === "ok" ? `  cer ${r.cer!.toFixed(3)}  latency ${r.finalLatencyMs} ms` : `  ${r.error ?? r.status}`}\n`);
      },
    });
  } catch (err) {
    io.err(`hearth: benchmark could not run: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const summary = summarize(results);
  const mode = opts.realtime ? "realtime" : "fast";
  const report = { mode, manifest: manifestPath, summary, results };
  io.out(JSON.stringify(report, null, 2) + "\n");
  if (opts.out) {
    const write = deps.writeFile ?? ((p: string, d: string) => writeFile(p, d));
    await write(`${opts.out}.json`, JSON.stringify(report, null, 2) + "\n");
    await write(`${opts.out}.csv`, toCsv(results));
    io.err(`hearth: wrote ${opts.out}.json and ${opts.out}.csv\n`);
  }
  // An item that failed to run is a failed benchmark; a recording not made yet is not.
  return summary.errors > 0 ? 1 : 0;
}
