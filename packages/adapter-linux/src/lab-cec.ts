/**
 * The CEC lab: send any HDMI-CEC command from this box and say, in plain words,
 * what the bus did about it.
 *
 * Why this exists. `cec-ctl` exits 0 for a transmit nobody acknowledged, prints
 * "Adapter is unconfigured" on a freshly booted Pi and *still* exits 0, and
 * answers "no reply" the same way whether the TV is off, deaf, or never got the
 * message. Every one of those looked like "the TV does not respond" from the
 * outside, and they have four different fixes. So each result here carries the
 * exact `cec-ctl` command line, the raw output, and a verdict that separates the
 * cases — and `diagnoseCec` walks the layers from the cable up and stops at the
 * first one that is not working.
 *
 * Nothing here is clever about the TV. A command is sent as written; the verdict
 * is read off what `cec-ctl` printed, never assumed. Where a command changes
 * state and the state can be read back (power), the result says whether the
 * read-back agreed — `sent` and `verified` are different words on purpose.
 */
import { access, readdir, readFile } from "node:fs/promises";
import { systemRunner, type Runner } from "./run.js";

export type CecVerdict =
  | "reply"             // the target answered, with content
  | "sent"              // acknowledged on the bus; no reply was expected, and nothing says it was acted on
  | "no-reply"          // acknowledged, a reply was expected, none came
  | "not-acknowledged"  // nobody on the bus accepted it
  | "feature-abort"     // the target answered "I do not support that"
  | "unconfigured"      // this adapter has no logical address, so it cannot transmit
  | "error";            // cec-ctl itself failed (not installed, no permission, bad flag)

export interface CecStepLog {
  /** The command, ready to paste into a shell. */
  cmdline: string;
  code: number;
  ms: number;
  /** stdout then stderr, trimmed and capped. */
  out: string;
}

export interface CecReadBack {
  wanted: string;
  reached: boolean;
  /** The last state read, or `null` if the TV never answered. */
  last: string | null;
  afterMs: number;
}

export interface CecLabResult {
  id: string;
  label: string;
  target: number;
  at: string;
  ms: number;
  verdict: CecVerdict;
  /** What the verdict means, for a person. */
  summary: string;
  /** `key: value` lines from the reply, e.g. `pwr-state: on (0x00)`. */
  facts: Record<string, string>;
  steps: CecStepLog[];
  readBack?: CecReadBack;
}

export interface CecContext {
  device: string;
  run: Runner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** CEC is slow: a transmit with a reply waits for the reply. */
export const CEC_LAB_TIMEOUT_MS = 15_000;

export function labContext(device = "/dev/cec0", run?: Runner): CecContext {
  return { device, run: run ?? systemRunner(CEC_LAB_TIMEOUT_MS) };
}

// ---------------------------------------------------------------------------------------------
// The catalogue

export type CecGroup = "adapter" | "info" | "power" | "source" | "keys";

export interface CecCommandDef {
  id: string;
  label: string;
  group: CecGroup;
  /** One or more `cec-ctl` argument lists, run in order. `{to}` is the target logical address, `{phys}` this adapter's physical address. */
  steps: string[][];
  expectsReply: boolean;
  /** True if it does something to the TV (or the room) rather than asking it something. */
  changesState: boolean;
  /** After this, read the TV's power state until it says this. */
  readBack?: "on" | "standby";
  explain: string;
}

const key = (name: string): string[][] => [
  ["--to", "{to}", "--user-control-pressed", `ui-cmd=${name}`],
  ["--to", "{to}", "--user-control-released"],
];

export const CEC_COMMANDS: CecCommandDef[] = [
  { id: "adapter-info", group: "adapter", label: "Adapter: address and state", steps: [[]], expectsReply: false, changesState: false,
    explain: "Reads this box's CEC adapter: its physical address (where it sits in the HDMI tree) and whether it has claimed a logical address. Touches nothing on the bus." },
  { id: "claim-playback", group: "adapter", label: "Claim a logical address (Playback)", steps: [["--playback"]], expectsReply: false, changesState: true,
    explain: "A freshly booted adapter has no logical address and every transmit fails until one is claimed. Hearth does this on its first transmit; this does it by hand." },
  { id: "topology", group: "adapter", label: "Scan the bus", steps: [["--show-topology"]], expectsReply: false, changesState: false,
    explain: "Polls the bus and lists every device that answered, with its physical address." },

  { id: "tv-power-status", group: "info", label: "TV: power status", steps: [["--to", "{to}", "--give-device-power-status"]], expectsReply: true, changesState: false,
    explain: "Asks the TV whether it is on or in standby. The question every other test depends on." },
  { id: "tv-vendor", group: "info", label: "TV: vendor", steps: [["--to", "{to}", "--give-device-vendor-id"]], expectsReply: true, changesState: false, explain: "Who made it, as it reports itself." },
  { id: "tv-osd-name", group: "info", label: "TV: name", steps: [["--to", "{to}", "--give-osd-name"]], expectsReply: true, changesState: false, explain: "The name the TV gives itself on the bus." },
  { id: "tv-cec-version", group: "info", label: "TV: CEC version", steps: [["--to", "{to}", "--get-cec-version"]], expectsReply: true, changesState: false, explain: "Which revision of the CEC standard the TV speaks." },
  { id: "tv-menu-language", group: "info", label: "TV: menu language", steps: [["--to", "{to}", "--get-menu-language"]], expectsReply: true, changesState: false, explain: "A harmless question that proves two-way traffic." },
  { id: "tv-physical-address", group: "info", label: "TV: physical address", steps: [["--to", "{to}", "--give-physical-addr"]], expectsReply: true, changesState: false, explain: "Where the TV believes it sits in the HDMI tree." },
  { id: "tv-audio-status", group: "info", label: "TV: audio status", steps: [["--to", "{to}", "--give-audio-status"]], expectsReply: true, changesState: false,
    explain: "Only audio systems answer this. A TV that aborts is behaving normally." },

  { id: "tv-standby", group: "power", label: "TV: standby", steps: [["--to", "{to}", "--standby"]], expectsReply: false, changesState: true, readBack: "standby",
    explain: "Puts the TV in standby, then reads its power state back to see whether it did." },
  { id: "tv-wake-image", group: "power", label: "TV: wake (Image View On)", steps: [["--to", "{to}", "--image-view-on"]], expectsReply: false, changesState: true, readBack: "on",
    explain: "The standard 'turn on and show me' message. Reads the power state back afterwards." },
  { id: "tv-wake-text", group: "power", label: "TV: wake (Text View On)", steps: [["--to", "{to}", "--text-view-on"]], expectsReply: false, changesState: true, readBack: "on",
    explain: "Like Image View On; some TVs listen to one and not the other." },
  { id: "key-power-on", group: "power", label: "Key: Power On function", steps: key("power-on-function"), expectsReply: false, changesState: true, readBack: "on",
    explain: "The remote-control 'power on' key, as a CEC key press." },
  { id: "key-power-off", group: "power", label: "Key: Power Off function", steps: key("power-off-function"), expectsReply: false, changesState: true, readBack: "standby",
    explain: "The remote-control 'power off' key, as a CEC key press." },

  { id: "active-source", group: "source", label: "Make this box the active source", steps: [["--active-source", "phys-addr={phys}"]], expectsReply: false, changesState: true,
    explain: "Broadcasts that this box is now the source being shown. Nothing reads the TV's input back; look at the screen." },
  { id: "set-stream-path", group: "source", label: "Set stream path to this box", steps: [["--set-stream-path", "phys-addr={phys}"]], expectsReply: false, changesState: true,
    explain: "Asks the whole bus to switch to this box's input. What Hearth uses to select a source." },
  { id: "request-active-source", group: "source", label: "Ask who the active source is", steps: [["--to", "15", "--request-active-source"]], expectsReply: false, changesState: false,
    explain: "Broadcast question; whoever is the active source should announce itself. Watch the Monitor." },

  ...(["volume-up", "volume-down", "mute", "up", "down", "left", "right", "select", "exit", "root-menu", "play", "pause", "stop"] as const).map((name): CecCommandDef => ({
    id: `key-${name}`, group: "keys", label: `Key: ${name}`, steps: key(name), expectsReply: false, changesState: true,
    explain: `Sends the remote-control '${name}' key (pressed, then released). A TV gives no acknowledgement that it acted on it: watch the screen.`,
  })),
];

export function findCommand(id: string): CecCommandDef | undefined {
  return CEC_COMMANDS.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------------------------
// Reading what cec-ctl said

export interface AdapterInfo {
  /** `3.0.0.0`; `f.f.f.f` means the TV never told this port where it is. */
  physical: string | undefined;
  /** Logical addresses claimed (empty on a fresh boot). */
  logical: number[];
  raw: string;
}

/** `cec-ctl -d <dev>` → what this adapter is. Pure, tested against recorded output. */
export function parseAdapterInfo(out: string): AdapterInfo {
  const physical = /Physical Address\s*:\s*([0-9a-f]\.[0-9a-f]\.[0-9a-f]\.[0-9a-f])/i.exec(out)?.[1];
  const mask = /Logical Address Mask\s*:\s*0x([0-9a-f]+)/i.exec(out)?.[1];
  const logical: number[] = [];
  if (mask) {
    const bits = parseInt(mask, 16);
    for (let i = 0; i < 15; i++) if (bits & (1 << i)) logical.push(i);
  }
  return { physical, logical, raw: out };
}

const cap = (s: string, n = 4_000): string => (s.length > n ? s.slice(0, n) + "\n… (cut)" : s);

/** The `key: value` lines of the reply cec-ctl printed, if it printed one. */
export function parseReplyFacts(out: string): Record<string, string> {
  const at = out.search(/Received from/i);
  if (at < 0) return {};
  const facts: Record<string, string> = {};
  for (const line of out.slice(at).split("\n").slice(1)) {
    const m = /^\s*([a-z][\w-]*)\s*:\s*(.+?)\s*$/i.exec(line);
    if (m && !/^(sequence|tx|rx|status|timestamp|received)/i.test(m[1]!)) facts[m[1]!] = m[2]!;
  }
  return facts;
}

const SEVERITY: CecVerdict[] = ["error", "unconfigured", "not-acknowledged", "feature-abort", "no-reply", "sent", "reply"];

/** Reads one transmit's verdict off its output. `expectsReply` says whether silence is a problem. */
export function interpretTransmit(out: string, code: number, expectsReply: boolean): CecVerdict {
  if (/Adapter is unconfigured|has no logical address|Device has no logical address/i.test(out)) return "unconfigured";
  if (code !== 0 && !/Received from/i.test(out)) return "error";
  // The same function the transport uses, restated here because the lab must not depend on the thing it is testing.
  if (/\bNot Acknowledged\b|\bNACK\b|\bLow Drive\b|\bArbitration Lost\b/i.test(out)) return "not-acknowledged";
  const received = out.search(/Received from/i);
  if (received >= 0 && /FEATURE_ABORT/.test(out.slice(received))) return "feature-abort";
  if (expectsReply) return received >= 0 ? "reply" : "no-reply";
  return "sent";
}

const SUMMARY: Record<CecVerdict, string> = {
  "reply": "The target answered.",
  "sent": "The bus acknowledged the message. Nothing says the target acted on it.",
  "no-reply": "The message was acknowledged but no reply came: the target heard it and stayed silent, or does not implement it.",
  "not-acknowledged": "Nobody acknowledged the message: nothing is listening at that address — the TV is off the bus, its CEC setting is off, or the cable does not carry CEC.",
  "feature-abort": "The target answered \"I do not support that\".",
  "unconfigured": "This adapter has no logical address yet, so it cannot transmit. Claim one first (Hearth does this on its first transmit).",
  "error": "cec-ctl itself failed — not installed, no permission on the device, or a flag it does not know.",
};

export function worst(verdicts: CecVerdict[]): CecVerdict {
  return SEVERITY.find((v) => verdicts.includes(v)) ?? "sent";
}

// ---------------------------------------------------------------------------------------------
// Running things

/** Arguments the raw box may pass through: flags and simple values, never a path or a shell word. */
const SAFE_TOKEN = /^[-A-Za-z0-9=.,_:+]+$/;

export function validateRawArgs(args: string[]): string | undefined {
  if (args.length === 0) return "nothing to send";
  if (args.length > 24) return "too many arguments";
  for (const a of args) {
    if (!SAFE_TOKEN.test(a)) return `"${a}" is not a plain cec-ctl flag or value`;
    if (/^(-d|--device|-D|--driver|--store|--analyze|-h|--help)/.test(a)) return `${a} is not allowed here (the device is chosen for you)`;
  }
  return undefined;
}

async function step(ctx: CecContext, args: string[]): Promise<{ log: CecStepLog; raw: string }> {
  const now = ctx.now ?? Date.now;
  const t0 = now();
  const r = await ctx.run("cec-ctl", ["-d", ctx.device, ...args]);
  const raw = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  return { raw, log: { cmdline: ["cec-ctl", "-d", ctx.device, ...args].join(" "), code: r.code, ms: now() - t0, out: cap(raw) } };
}

export async function readAdapter(ctx: CecContext): Promise<AdapterInfo & { log: CecStepLog }> {
  const { raw, log } = await step(ctx, []);
  return { ...parseAdapterInfo(raw), log };
}

/** Claim a logical address if the adapter has none. Returns the log of what was done, if anything. */
export async function ensureClaimed(ctx: CecContext): Promise<{ info: AdapterInfo; claimed: CecStepLog | undefined }> {
  const info = await readAdapter(ctx);
  if (info.logical.length > 0) return { info, claimed: undefined };
  const claim = await step(ctx, ["--playback"]);
  const after = await readAdapter(ctx);
  return { info: after, claimed: claim.log };
}

function fill(args: string[], to: number, phys: string | undefined): string[] {
  return args.map((a) => a.replace("{to}", String(to)).replace("{phys}", phys ?? "f.f.f.f"));
}

export interface RunOptions {
  target?: number;
  /** Claim a logical address first if there is none. Default true. */
  claim?: boolean;
  /** Longest to wait for a read-back, ms. Default 12 000. */
  readBackMs?: number;
}

export async function runCecCommand(ctx: CecContext, def: CecCommandDef, opts: RunOptions = {}): Promise<CecLabResult> {
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const target = opts.target ?? 0;
  const t0 = now();
  const steps: CecStepLog[] = [];

  let info: AdapterInfo | undefined;
  if (def.id !== "adapter-info" && def.id !== "claim-playback" && (opts.claim ?? true)) {
    const c = await ensureClaimed(ctx);
    info = c.info;
    if (c.claimed) steps.push(c.claimed);
  } else if (def.steps.some((s) => s.some((a) => a.includes("{phys}")))) {
    info = await readAdapter(ctx);
  }

  const verdicts: CecVerdict[] = [];
  let facts: Record<string, string> = {};
  for (const template of def.steps) {
    const { log, raw } = await step(ctx, fill(template, target, info?.physical));
    steps.push(log);
    if (template.length === 0 || template[0] === "--show-topology") {
      // Reading the adapter or the bus does not transmit: it can fail only as a whole.
      verdicts.push(log.code === 0 ? "reply" : "error");
      facts = { ...facts, ...adapterFacts(raw), ...parseTopologyFacts(raw) };
    } else if (template[0] === "--playback") {
      verdicts.push(log.code === 0 ? "sent" : "error");
      facts = { ...facts, ...adapterFacts(raw) };
    } else {
      verdicts.push(interpretTransmit(raw, log.code, def.expectsReply && template === def.steps[def.steps.length - 1]));
      facts = { ...facts, ...parseReplyFacts(raw) };
    }
  }

  let verdict = worst(verdicts);
  const readsAdapterOnly = def.steps.every((s) => s.length === 0 || s[0] === "--show-topology");
  const result: CecLabResult = {
    id: def.id, label: def.label, target, at: new Date(t0).toISOString(), ms: 0,
    verdict, summary: readsAdapterOnly && verdict === "reply" ? "Read from this box's adapter; nothing was sent to the TV." : SUMMARY[verdict], facts, steps,
  };

  if (def.readBack && (verdict === "sent" || verdict === "reply")) {
    const wanted = def.readBack;
    const limit = opts.readBackMs ?? 12_000;
    const start = now();
    let last: string | null = null;
    let reached = false;
    for (;;) {
      const { raw } = await step(ctx, ["--to", String(target), "--give-device-power-status"]);
      last = /pwr-state:\s*([a-z-]+)/i.exec(raw)?.[1]?.toLowerCase() ?? null;
      if (last === wanted) { reached = true; break; }
      if (now() - start >= limit) break;
      await sleep(1_000);
    }
    result.readBack = { wanted, reached, last, afterMs: now() - start };
    result.summary = reached
      ? `${SUMMARY[verdict]} The TV then reported "${wanted}" — verified by read-back.`
      : `${SUMMARY[verdict]} But the TV did NOT report "${wanted}" within ${Math.round(limit / 1000)} s (last read: ${last ?? "no answer"}) — it accepted the message and did not do it.`;
  }
  result.ms = now() - t0;
  return result;
}

export async function runCecRaw(ctx: CecContext, args: string[], opts: { claim?: boolean } = {}): Promise<CecLabResult> {
  const bad = validateRawArgs(args);
  const at = new Date().toISOString();
  if (bad) {
    return { id: "raw", label: "Raw", target: -1, at, ms: 0, verdict: "error", summary: bad, facts: {}, steps: [] };
  }
  const now = ctx.now ?? Date.now;
  const t0 = now();
  const steps: CecStepLog[] = [];
  if (opts.claim ?? true) {
    const c = await ensureClaimed(ctx);
    if (c.claimed) steps.push(c.claimed);
  }
  const { log, raw } = await step(ctx, args);
  steps.push(log);
  // For a free-form command, "reply expected" is whatever the output shows: if a reply block is there it is a reply.
  const verdict = interpretTransmit(raw, log.code, false);
  const hasReply = /Received from/i.test(raw);
  const final: CecVerdict = verdict === "sent" && hasReply ? "reply" : verdict;
  return { id: "raw", label: `cec-ctl ${args.join(" ")}`, target: -1, at, ms: now() - t0, verdict: final, summary: SUMMARY[final], facts: parseReplyFacts(raw), steps };
}

/** The device tree `cec-ctl --show-topology` prints: `0.0.0.0: TV`, one line per device on the bus. */
export function parseTopologyFacts(raw: string): Record<string, string> {
  const at = raw.search(/Topology:/i);
  if (at < 0) return {};
  const out: Record<string, string> = {};
  for (const line of raw.slice(at).split("\n").slice(1)) {
    const m = /^\s*([0-9a-f]\.[0-9a-f]\.[0-9a-f]\.[0-9a-f]):\s*(.+?)\s*$/i.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function adapterFacts(raw: string): Record<string, string> {
  const i = parseAdapterInfo(raw);
  return {
    ...(i.physical ? { "physical-address": i.physical } : {}),
    "logical-addresses": i.logical.length ? i.logical.join(",") : "none claimed",
  };
}

// ---------------------------------------------------------------------------------------------
// Diagnosis: the layers, from the cable up

export type DiagStatus = "ok" | "warn" | "fail" | "skipped";

export interface DiagStep {
  layer: string;
  status: DiagStatus;
  detail: string;
  /** What to do about it, when there is something. */
  fix?: string;
}

export interface DiagnoseIo {
  /** `[{ name: "card0-HDMI-A-1", status: "connected" }]`. Default reads /sys/class/drm. */
  drm?: () => Promise<Array<{ name: string; status: string }>>;
  /** `vcgencmd get_throttled`, or `undefined` if it is not there. */
  throttled?: () => Promise<string | undefined>;
  deviceExists?: (path: string) => Promise<boolean>;
}

async function defaultDrm(): Promise<Array<{ name: string; status: string }>> {
  try {
    const names = (await readdir("/sys/class/drm")).filter((n) => /HDMI/i.test(n));
    return await Promise.all(names.map(async (name) => ({
      name, status: (await readFile(`/sys/class/drm/${name}/status`, "utf8").catch(() => "unknown")).trim(),
    })));
  } catch { return []; }
}

export async function diagnoseCec(ctx: CecContext, io: DiagnoseIo = {}): Promise<{ steps: DiagStep[]; firstProblem: DiagStep | undefined }> {
  const steps: DiagStep[] = [];
  const add = (s: DiagStep): DiagStep => { steps.push(s); return s; };
  const stop = (layer: string): void => { steps.push({ layer, status: "skipped", detail: "not checked: a layer below it is not working" }); };

  // 0. power — a board that is browning out drops bus signals and slows everything
  const thr = await (io.throttled ?? (async () => (await ctx.run("vcgencmd", ["get_throttled"])).stdout.trim() || undefined))().catch(() => undefined);
  const thrValue = thr ? /0x([0-9a-f]+)/i.exec(thr)?.[1] : undefined;
  if (thrValue === undefined) add({ layer: "Power", status: "skipped", detail: "vcgencmd is not available, so under-voltage is unknown" });
  else if (parseInt(thrValue, 16) & 0xf) add({ layer: "Power", status: "warn", detail: `under-voltage or throttling right now (get_throttled=0x${thrValue})`, fix: "Use a shorter, thicker power cable or a stronger supply; everything below is less trustworthy until this reads 0x0." });
  else add({ layer: "Power", status: "ok", detail: `get_throttled=0x${thrValue}${parseInt(thrValue, 16) ? " (it dipped earlier this boot, not now)" : ""}` });

  // 1. the tool and the adapter
  const version = await ctx.run("cec-ctl", ["--version"]).catch(() => ({ code: 127, stdout: "", stderr: "" }));
  if (version.code !== 0) {
    add({ layer: "cec-ctl", status: "fail", detail: "cec-ctl is not installed", fix: "sudo apt install v4l-utils" });
    for (const l of ["Adapter", "HDMI cable", "Physical address", "Logical address", "TV on the bus"]) stop(l);
    return { steps, firstProblem: steps.find((s) => s.status === "fail") };
  }
  add({ layer: "cec-ctl", status: "ok", detail: version.stdout.split("\n")[0]?.trim() || "installed" });

  const exists = await (io.deviceExists ?? ((p) => access(p).then(() => true, () => false)))(ctx.device);
  const adapter = exists ? await readAdapter(ctx) : undefined;
  if (!exists) {
    add({ layer: "Adapter", status: "fail", detail: `${ctx.device} does not exist`, fix: "On a Pi, CEC needs the vc4 KMS driver (dtoverlay=vc4-kms-v3d) and an HDMI cable in the port nearest the power input." });
    for (const l of ["HDMI cable", "Physical address", "Logical address", "TV on the bus"]) stop(l);
    return { steps, firstProblem: steps.find((s) => s.status === "fail") };
  }
  if (adapter!.log.code !== 0) {
    add({ layer: "Adapter", status: "fail", detail: `cec-ctl could not open ${ctx.device}: ${adapter!.log.out.split("\n")[0]}`, fix: "Add this user to the video group: sudo usermod -aG video $USER, then log out and in." });
    for (const l of ["HDMI cable", "Physical address", "Logical address", "TV on the bus"]) stop(l);
    return { steps, firstProblem: steps.find((s) => s.status === "fail") };
  }
  add({ layer: "Adapter", status: "ok", detail: `${ctx.device} opens` });

  // 2. the cable
  const drm = await (io.drm ?? defaultDrm)();
  const connected = drm.filter((d) => d.status === "connected");
  if (drm.length === 0) add({ layer: "HDMI cable", status: "skipped", detail: "no DRM HDMI connector found to ask" });
  else if (connected.length === 0) add({ layer: "HDMI cable", status: "fail", detail: `no HDMI sink detected (${drm.map((d) => `${d.name}: ${d.status}`).join(", ")})`, fix: "The TV is off at the wall, on a different cable, or the cable is loose. CEC cannot work without hot-plug." });
  else add({ layer: "HDMI cable", status: "ok", detail: `${connected.map((d) => d.name).join(", ")} connected` });

  // 3. the physical address
  if (!adapter!.physical) add({ layer: "Physical address", status: "warn", detail: "cec-ctl printed none" });
  else if (/^f\.f\.f\.f$/i.test(adapter!.physical)) add({ layer: "Physical address", status: "fail", detail: "f.f.f.f — the TV never told this port where it sits", fix: "The TV did not provide an EDID: check the cable, the TV's input, and that the TV is on. Without a physical address this adapter stays unconfigured." });
  else add({ layer: "Physical address", status: "ok", detail: adapter!.physical });

  // 4. the logical address
  let info: AdapterInfo = adapter!;
  if (info.logical.length === 0) {
    const c = await ensureClaimed(ctx);
    info = c.info;
    if (info.logical.length > 0) add({ layer: "Logical address", status: "warn", detail: `none claimed (a fresh boot has none) — claimed ${info.logical.join(",")} just now with cec-ctl --playback`, fix: "Normal after a reboot. Hearth claims one on its first transmit; a hand-written script must do it too, or every transmit prints \"Adapter is unconfigured\"." });
    else add({ layer: "Logical address", status: "fail", detail: "could not claim one", fix: "Usually the physical address above is f.f.f.f, or another program owns the adapter." });
  } else add({ layer: "Logical address", status: "ok", detail: `claimed ${info.logical.join(",")}` });

  if (info.logical.length === 0) { stop("TV on the bus"); return { steps, firstProblem: steps.find((s) => s.status === "fail") }; }

  // 5. the TV
  const { raw, log } = await step(ctx, ["--to", "0", "--give-device-power-status"]);
  const v = interpretTransmit(raw, log.code, true);
  const facts = parseReplyFacts(raw);
  if (v === "reply") add({ layer: "TV on the bus", status: "ok", detail: `the TV answered: power ${facts["pwr-state"] ?? "(no state)"}` });
  else if (v === "not-acknowledged") add({ layer: "TV on the bus", status: "fail", detail: "nobody acknowledged a message to the TV (address 0)", fix: "Enable CEC on the TV (it may be called EasyLink, Anynet+, Bravia Sync or HDMI Control), make sure it is on, and use the HDMI port that supports CEC." });
  else if (v === "no-reply") add({ layer: "TV on the bus", status: "warn", detail: "the TV acknowledged but did not answer", fix: "Some TVs ignore queries from a device they do not list. Try the Wake and Standby commands and watch the screen." });
  else add({ layer: "TV on the bus", status: "fail", detail: `${v}: ${log.out.split("\n")[0] ?? ""}` });

  return { steps, firstProblem: steps.find((s) => s.status === "fail") ?? steps.find((s) => s.status === "warn") };
}
