#!/usr/bin/env node
// Record the spoken commands in a manifest, in your own voice, on the box that will hear them.
//
//   node tools/voice-record.mjs                                  bench/voice/commands.json into ~/hearth-voice/commands
//   node tools/voice-record.mjs bench/voice/commands.json --dir ~/hearth-voice/commands
//   node tools/voice-record.mjs --only zh-quieter,zh-hdmi3       just these ids
//   node tools/voice-record.mjs --redo                           record again over clips that already exist
//
// Then `node tools/voice-replay.mjs --tv-module <path>` plays each one into Hearth as if it were the microphone and
// reads the television back. Run this in a terminal of your own (ssh -t): it waits for Enter before each phrase.
//
// The clips stay on this machine and out of the repository: they are someone's voice. Each is kept only if it is clearly
// louder than the room, because a silent clip replayed later fails as "not heard", which would blame the recogniser for
// what was a recording that caught nothing.
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin, stdout, argv, env, exit } from "node:process";

const RATE = 16000;
const SECONDS = Number(env.HEARTH_RECORD_SECONDS ?? 5);
const DEVICE = env.HEARTH_AUDIO_DEVICE && !env.HEARTH_AUDIO_DEVICE.startsWith("file:") ? env.HEARTH_AUDIO_DEVICE : "default";

const args = argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const only = flag("--only")?.split(",");
const dir = resolve((flag("--dir") ?? join(homedir(), "hearth-voice", "commands")).replace(/^~(?=\/|$)/, homedir()));
const redo = args.includes("--redo") ? (args.splice(args.indexOf("--redo"), 1), true) : false;
const manifestPath = resolve(args[0] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "voice", "commands.json"));

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const items = manifest.items.filter((i) => !only || only.includes(i.id));
if (items.length === 0) { console.error(`nothing to record: no ids in ${manifestPath} match ${only}`); exit(2); }
await mkdir(dir, { recursive: true });

const record = (file, seconds) => new Promise((ok, fail) => {
  const p = spawn("arecord", ["-D", DEVICE, "-f", "S16_LE", "-r", String(RATE), "-c", "1", "-d", String(seconds), "-q", file], { stdio: ["ignore", "ignore", "inherit"] });
  p.on("error", fail);
  p.on("exit", (code) => code === 0 ? ok() : fail(new Error(`arecord exited ${code} — is the microphone there? (device '${DEVICE}')`)));
});

/** Root-mean-square of the 16-bit samples after the 44-byte header arecord writes, 0..1. */
const rms = (wav) => {
  let sum = 0; const n = Math.floor((wav.length - 44) / 2);
  for (let i = 0; i < n; i++) { const s = wav.readInt16LE(44 + i * 2) / 32768; sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
};
const dB = (r) => (20 * Math.log10(Math.max(r, 1e-6))).toFixed(1);

console.log(`Recording ${items.length} phrase(s) into ${dir} from '${DEVICE}', ${SECONDS} s each.`);
console.log("First, 3 seconds of the room as it is. Stay quiet...");
const roomFile = join(dir, "_room.wav");
await record(roomFile, 3);
const room = rms(await readFile(roomFile));
await rm(roomFile);
console.log(`  room: ${dB(room)} dBFS`);

const rl = createInterface({ input: stdin, output: stdout });
const failed = [];
for (const item of items) {
  const file = join(dir, `${item.id}.wav`);
  if (!redo && await stat(file).then(() => true, () => false)) { console.log(`- ${item.id}: already recorded (--redo to replace)`); continue; }
  let kept = false;
  for (let attempt = 1; attempt <= 3 && !kept; attempt++) {
    await rl.question(`\n- ${item.id}: press Enter, then say  「${item.say}」  `);
    stdout.write("  ● recording...");
    const tmp = `${file}.part`;
    await record(tmp, SECONDS);
    const level = rms(await readFile(tmp));
    // 10 dB above the room is a low bar; a sentence said to a television clears it easily.
    if (level >= room * 3.16) { await rename(tmp, file); kept = true; console.log(` kept (${dB(level)} dBFS, room ${dB(room)})`); }
    else console.log(` too quiet (${dB(level)} dBFS vs room ${dB(room)}): nothing was heard. Closer, and start right after Enter.`);
  }
  if (!kept) failed.push(item.id);
}
rl.close();
console.log(failed.length ? `\nNot recorded: ${failed.join(", ")}. Run again to retry them.` : `\nDone. Next:  node tools/voice-replay.mjs --tv-module <path>`);
exit(failed.length ? 1 : 0);
