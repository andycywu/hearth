#!/usr/bin/env node
// Play each recorded command into Hearth as if it were the microphone, and read the television back.
//
//   node tools/voice-replay.mjs --tv-module <path>                         every clip in ~/hearth-voice/commands
//   node tools/voice-replay.mjs bench/voice/commands.json --tv-module <path> --dir ~/hearth-voice/commands
//   node tools/voice-replay.mjs --tv-module <path> --only zh-quieter
//
// For each clip: read the television, start Hearth with the clip as its microphone (HEARTH_AUDIO_DEVICE=file:...), wait
// for the turn to finish, read the television again, judge (apps/cli/src/voice-replay.ts), and put the television back
// the way it was so the next clip starts from the same place. Hearth's own settings come from the environment and
// ~/.config/hearth/config.json as for any run: the recogniser, the wake detector and the HEARTH_STT_* paths are the ones
// the box really uses.
//
// What this proves is everything after the air: recognition of a real voice, the wake word, planning, the television's
// answer. It does not prove the air — distance, the room, the television's own sound. That still needs a person.
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { argv, env, exit, execPath } from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const home = (p) => p.replace(/^~(?=\/|$)/, homedir());
const tvModulePath = flag("--tv-module") ?? env.HEARTH_TV_MODULE;
const only = flag("--only")?.split(",");
const dir = resolve(home(flag("--dir") ?? join(homedir(), "hearth-voice", "commands")));
const cli = resolve(flag("--cli") ?? join(ROOT, "apps", "cli", "dist", "main.js"));
const manifestPath = resolve(args[0] ?? join(ROOT, "bench", "voice", "commands.json"));
if (!tvModulePath) { console.error("voice-replay: give --tv-module <path> (or HEARTH_TV_MODULE): the television is read through it"); exit(2); }

const { loadTvModule } = await import(pathToFileURL(join(ROOT, "apps", "cli", "dist", "tv-module.js")).href);
const { judge, readTvState, restoreTvState } = await import(pathToFileURL(join(ROOT, "apps", "cli", "dist", "voice-replay.js")).href);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const items = [];
for (const item of manifest.items.filter((i) => !only || only.includes(i.id))) {
  const wav = join(dir, `${item.id}.wav`);
  if (await stat(wav).then(() => true, () => false)) items.push({ ...item, wav });
  else console.log(`- ${item.id}: no recording at ${wav} (tools/voice-record.mjs) — skipped`);
}
if (items.length === 0) { console.error(`voice-replay: nothing to replay in ${dir}`); exit(2); }

/** Seconds of 16 kHz mono 16-bit audio in a WAV, from its size. */
const seconds = async (wav) => ((await stat(wav)).size - 44) / 32000;

/**
 * Run Hearth once with the clip as its microphone. The turn is over when it reports the speech it gave, or an error.
 * The television is read back the moment the answer is printed — after the command, before the answer is spoken — and
 * never after Hearth is stopped: on the way out Hearth puts the screen back (the module's close), and a panel read after
 * that would be a reading of the clean-up. Before the speech, because the television this was written against lowers its
 * own volume, a step at a time, while the box's HDMI audio plays for more than a few seconds (2026-11-04: reproduced with
 * espeak-ng alone, no Hearth running); a reading taken after a long reply would credit "turn it down" to the reply.
 */
function hear(wav, durationS, readAfter) {
  return new Promise((done) => {
    const trace = []; let output = ""; let finished = false; let heardAt;
    const child = spawn(execPath, [cli, "--tv-module", tvModulePath, "--serve"], {
      cwd: ROOT, env: { ...env, HEARTH_AUDIO_DEVICE: `file:${wav}`, HEARTH_VOICE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const started = Date.now();
    let reading; let stopping = false;
    const read = () => (reading ??= readAfter().catch(() => ({})));
    const stop = () => {
      if (stopping) return; stopping = true; clearInterval(tick);
      void read().finally(() => child.kill("SIGTERM"));
    };
    child.stdout.on("data", (b) => { output += b; if (heardAt) void read(); });
    let partial = "";
    child.stderr.on("data", (b) => {
      const lines = (partial + b).split("\n"); partial = lines.pop() ?? "";
      for (const line of lines) {
        trace.push(line);
        if (/🎤 (?!\()/u.test(line)) heardAt ??= Date.now();
        if (/🔊 speech began/u.test(line) || (heardAt && /^hearth: /.test(line))) { finished = true; setTimeout(stop, 1000); }
      }
    });
    // Start-up (models, the room, the television) takes a while on a Pi 3; the clip then plays at its own pace. After that,
    // a command that was heard gets a minute to be planned and answered; one that was not is over once the clip has ended.
    const tick = setInterval(() => {
      const t = (Date.now() - started) / 1000;
      if (heardAt ? (Date.now() - heardAt) / 1000 > 60 : t > 45 + durationS) stop();
    }, 500);
    child.on("exit", () => { clearInterval(tick); void Promise.resolve(reading).then((after) => done({ trace, output, finished, after })); });
  });
}

const tv = await loadTvModule(tvModulePath, env);
await tv.init?.();
console.log(`Replaying ${items.length} clip(s) through ${tv.name ?? tvModulePath}.\n`);
const rows = [];
try {
  for (const item of items) {
    const before = await readTvState(tv);
    process.stdout.write(`- ${item.id}  「${item.say}」  `);
    const result = await hear(item.wav, await seconds(item.wav), () => readTvState(tv));
    const after = result.after ?? await readTvState(tv);
    const verdict = judge(item.expect, before, after, result);
    // Put back from where the television is now, not from the reading: it may have drifted since (see hear()).
    const restored = await restoreTvState(tv, before, await readTvState(tv));
    console.log(verdict.status.toUpperCase());
    for (const c of verdict.checks) console.log(`    ${c.status.padEnd(10)} ${c.what.padEnd(7)} ${c.detail}`);
    if (result.output.trim()) console.log(`    answer     ${result.output.trim().split("\n").join(" / ").slice(0, 160)}`);
    if (restored.length) console.log(`    put back  ${restored.join(", ")}`);
    rows.push({ id: item.id, status: verdict.status, heard: verdict.heard });
  }
} finally {
  await Promise.resolve(tv.close?.()).catch(() => {});
}

console.log("\nSummary");
for (const r of rows) console.log(`  ${r.status.toUpperCase().padEnd(11)} ${r.id.padEnd(18)} heard: ${r.heard ?? "(nothing)"}`);
const failed = rows.filter((r) => r.status === "failed").length;
console.log(`\n${rows.length - failed}/${rows.length} not failed; ${rows.filter((r) => r.status === "verified").length} verified by reading the television back.`);
exit(failed ? 1 : 0);
