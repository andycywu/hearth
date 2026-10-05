/**
 * `hearth setup` — look at this box once, so nobody has to type flags again.
 *
 * The first Pi report took four attempts to run, and none of the failures were
 * about Hearth: Node was on the PATH only through `.profile`, the Pi's repo had
 * a stash in the way, a script had been swallowed by that stash. Setup exists so
 * the *second* person's first run is one word. It looks at what is here, writes
 * what it found to `~/.config/hearth/config.json`, and says in plain terms what
 * this box can do and what one `apt install` would add.
 *
 * It never installs anything itself. A tool that runs `apt` on someone's
 * machine has to be trusted more than a tool that reports — and the report is
 * the thing people can check.
 */
import { access, writeFile } from "node:fs/promises";
import { execPath, version as nodeVersion } from "node:process";
import { dirname, join } from "node:path";
import { createLinuxCecTransport, describeHost, detectAudioBackend, detectVoice, systemRunner, type Runner } from "@hearthkit/adapter-linux";
import type { CliOptions } from "./args.js";
import { configPath, loadConfig, saveConfig, type HearthConfig } from "./config.js";

export interface SetupIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface SetupDeps {
  run?: Runner;
  /** `true` if the path exists. Substituted in tests. */
  exists?: (path: string) => Promise<boolean>;
  configPath?: string;
  /** Where the systemd unit template goes. Default beside the config. */
  unitPath?: string;
  nodeVersion?: string;
  nodePath?: string;
  /** Where the built CLI lives, for the unit's ExecStart. */
  cliPath?: string;
  /** Name of the user running setup, for the unit's `User=` hint. */
  user?: string;
  readFile?: (path: string) => Promise<string>;
}

interface Finding {
  what: string;
  ok: boolean | "partial";
  detail: string;
  /** What would change the answer, when something would. */
  fix?: string;
}

export async function runSetup(opts: CliOptions, io: SetupIo, deps: SetupDeps = {}): Promise<number> {
  if (opts.platform !== "linux") {
    io.err("hearth: setup looks at a Linux box; the mock TV has nothing to set up.\n" +
      "        Run `hearth --platform linux setup`, or set TV_PLATFORM=linux.\n");
    return 2;
  }

  const run = deps.run ?? systemRunner();
  const exists = deps.exists ?? fileExists;
  const path = deps.configPath ?? configPath();
  const node = deps.nodeVersion ?? nodeVersion;
  const findings: Finding[] = [];

  // --- the box ---------------------------------------------------------------
  const host = await describeHost(deps.readFile);
  const major = Number(node.replace(/^v/, "").split(".")[0]);
  findings.push({
    what: "Node",
    ok: major >= 26,
    detail: `${node} at ${deps.nodePath ?? execPath}`,
    ...(major >= 26 ? {} : { fix: "Hearth needs Node 26 or newer (.nvmrc)." }),
  });

  // --- audio -----------------------------------------------------------------
  const audio = await detectAudioBackend(run);
  findings.push(audio
    ? { what: "Volume & mute", ok: true, detail: `through ${audio.name}` }
    : { what: "Volume & mute", ok: false, detail: "no wpctl, pactl or amixer answered",
        fix: "On a Pi: `sudo apt install pipewire wireplumber` (or `alsa-utils` for amixer)." });

  // --- HDMI-CEC ----------------------------------------------------------------
  const cecDevice = opts.cec === false ? null : opts.cec;
  let cec: Finding;
  if (!cecDevice) {
    cec = { what: "HDMI-CEC", ok: "partial", detail: "left alone (--no-cec)" };
  } else {
    const hasCtl = (await run("cec-ctl", ["--version"])).code === 0;
    const hasDev = await exists(cecDevice);
    const inVideo = /(^|\s)video(\s|$)/.test((await run("id", ["-nG"])).stdout);
    const bus = hasCtl && hasDev ? createLinuxCecTransport({ device: cecDevice, run }) : undefined;
    const available = bus ? await bus.available().catch(() => false) : false;
    if (available) {
      cec = { what: "HDMI-CEC", ok: true, detail: `${cecDevice} answers; the TV and anything on the bus can be discovered` };
    } else if (!hasCtl) {
      cec = { what: "HDMI-CEC", ok: false, detail: "cec-ctl is not installed", fix: "`sudo apt install v4l-utils`" };
    } else if (!hasDev) {
      cec = { what: "HDMI-CEC", ok: false, detail: `${cecDevice} does not exist`,
        fix: "On a Pi: `dtoverlay=vc4-kms-v3d` in /boot/firmware/config.txt, HDMI cable on the port CEC is enabled for, then reboot." };
    } else if (!inVideo) {
      cec = { what: "HDMI-CEC", ok: false, detail: `${cecDevice} exists but this user is not in the video group`,
        fix: `\`sudo usermod -aG video ${deps.user ?? "$USER"}\`, then log out and in.` };
    } else {
      cec = { what: "HDMI-CEC", ok: false, detail: `${cecDevice} exists but cec-ctl could not use it`,
        fix: "Check `cec-ctl -d " + cecDevice + " -S` by hand; is the TV on and the cable in?" };
    }
  }
  findings.push(cec);

  // --- voice -------------------------------------------------------------------
  const heard = await detectVoice(run);
  const asr = opts.asrBaseUrl;
  if (heard.capture && heard.tts) {
    findings.push(asr
      ? { what: "Voice", ok: true, detail: `microphone (arecord) and speech (espeak-ng); transcription at ${asr}` }
      : { what: "Voice", ok: "partial", detail: "microphone (arecord) and speech (espeak-ng) are here, but nothing turns speech into text",
          fix: "Re-run with `--asr http://<host>:<port>/v1` pointing at an OpenAI-compatible /audio/transcriptions (a whisper server on the LAN will do)." });
  } else if (heard.tts) {
    findings.push({ what: "Voice", ok: "partial", detail: "can speak (espeak-ng) but has no capture device",
      fix: "Plug in a microphone or a ReSpeaker HAT; `arecord -l` should list a card." });
  } else if (heard.capture) {
    findings.push({ what: "Voice", ok: "partial", detail: "has a microphone but nothing to speak with",
      fix: "`sudo apt install espeak-ng`" });
  } else {
    findings.push({ what: "Voice", ok: false, detail: "no microphone and no speech engine",
      fix: "`sudo apt install alsa-utils espeak-ng` and a microphone, if you want to talk to it." });
  }

  // --- status ring -------------------------------------------------------------
  const hasSpi = await exists("/dev/spidev0.1");
  findings.push(hasSpi
    ? { what: "Status ring", ok: true, detail: "/dev/spidev0.1 exists (a ReSpeaker array's APA102 ring)" }
    : { what: "Status ring", ok: "partial", detail: "no /dev/spidev0.1 — fine unless this box has a ReSpeaker array" });

  // --- what the next `hearth` will do -----------------------------------------
  const previous = await loadConfig(path);
  const config: HearthConfig = {
    ...previous,
    platform: "linux",
    cec: cecDevice === null ? false : cec.ok === true ? cecDevice : previous.cec ?? cecDevice,
    voice: Boolean(heard.capture && asr),
    ...(asr ? { asrBaseUrl: asr } : {}),
    ...(opts.asrModel ? { asrModel: opts.asrModel } : {}),
    leds: hasSpi,
    // Default to an attention word whenever this box will listen: a room
    // microphone that acts on everything it hears is a thing to opt into, not
    // to discover.
    ...(heard.capture && asr ? { wakeWord: opts.wakeWord ?? previous.wakeWord ?? "hearth" } : {}),
    ...(opts.baseUrl ? { llmBaseUrl: opts.baseUrl } : {}),
    ...(opts.baseUrl && opts.model ? { llmModel: opts.model } : {}),
    writtenBy: `hearth setup, Node ${node}`,
    writtenAt: new Date().toISOString(),
  };

  // --- the page ------------------------------------------------------------------
  const lines: string[] = [];
  lines.push(`This box: ${host.model} · ${host.osVersion}${host.soc !== "unknown" ? ` · ${host.soc}` : ""}`);
  lines.push("");
  for (const f of findings) {
    const mark = f.ok === true ? "✓" : f.ok === "partial" ? "~" : "✗";
    lines.push(`  ${mark} ${f.what.padEnd(14)} ${f.detail}`);
    if (f.fix) lines.push(`    ${"".padEnd(14)} → ${f.fix}`);
  }
  lines.push("");
  const can = [
    audio && "set and read volume and mute",
    cec.ok === true && "discover the TV and anything on the HDMI-CEC bus, and wake or stand by what answers",
    heard.tts && "speak its replies",
    heard.capture && asr && "listen on the microphone",
  ].filter(Boolean);
  lines.push(can.length
    ? `So \`hearth\` on this box can ${can.join("; ")}.`
    : "So `hearth` on this box can run the agent, but cannot change anything about the room yet.");
  lines.push("It cannot switch inputs or press keys on a television from here — only a device on the bus can be asked to.");
  lines.push("");

  if (opts.json) {
    io.out(JSON.stringify({ host, findings, config }, null, 2) + "\n");
  } else {
    io.out(lines.join("\n") + "\n");
  }

  // --- write --------------------------------------------------------------------
  const unitPath = deps.unitPath ?? join(dirname(path), "hearth.service");
  if (opts.save) {
    await saveConfig(config, path);
    if (!opts.json) {
      io.out(`Wrote ${path}\n`);
      io.out("Next `hearth \"turn it down\"` needs no flags.\n");
      if (config.wakeWord) {
        io.out(`It will listen, and act only on what follows "${config.wakeWord}" — e.g. "${config.wakeWord}, turn it down".\n`);
        io.out("(--wake <word> changes it, --no-wake makes it act on everything it hears.)\n");
      }
    }
    // A boot service only makes sense for a box that can listen: without a
    // microphone and a transcriber the agent reads stdin, finds none, and exits.
    if (config.voice) {
      await writeFile(unitPath, systemdUnit({
        node: deps.nodePath ?? execPath,
        cli: deps.cliPath ?? defaultCliPath(),
        voice: true,
        leds: config.leds ?? false,
        ...(config.wakeWord ? { wakeWord: config.wakeWord } : {}),
      }), "utf8");
      if (!opts.json) {
        io.out(`\nA user service template is at ${unitPath} — to run Hearth at boot:\n`);
        io.out(`  mkdir -p ~/.config/systemd/user && cp ${unitPath} ~/.config/systemd/user/\n`);
        io.out("  systemctl --user enable --now hearth && loginctl enable-linger $USER\n");
        io.out("Node's path is pinned in it, because a service starts with no .profile.\n");
      }
    } else if (!opts.json) {
      io.out("\nNo boot service yet: it would have nothing to listen with. Re-run setup with --asr once it can.\n");
    }
  } else if (!opts.json) {
    io.out(`Would write ${path}:\n${JSON.stringify(config, null, 2)}\n(nothing written: --no-save)\n`);
  }

  // Exit status is about the box being usable at all, not about every row.
  return major >= 26 ? 0 : 1;
}

/**
 * The unit, with Node's absolute path in ExecStart.
 *
 * Learned on the first Pi: Node lived in `~/.local/node/bin`, on PATH only via
 * `.profile`, and a non-interactive ssh — the same environment a service gets —
 * could not find it. A unit that said `node` would fail at boot with a message
 * nobody would connect to their shell profile.
 */
export function systemdUnit(o: { node: string; cli: string; voice: boolean; leds: boolean; wakeWord?: string }): string {
  const flags = [
    "--platform linux", "--yes", o.voice ? "--voice" : "", o.leds ? "--leds" : "",
    o.wakeWord ? `--wake ${JSON.stringify(o.wakeWord)}` : "",
  ].filter(Boolean).join(" ");
  return [
    "[Unit]",
    "Description=Hearth — the living-room agent, on this box",
    "After=network-online.target sound.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${o.node} ${o.cli} ${flags}`,
    "Restart=on-failure",
    "RestartSec=5",
    "# Hearth reads ~/.config/hearth/config.json; flags above beat it.",
    "# --yes: nobody is at a terminal to approve a gated step. Remove it to make",
    "# the service decline them instead.",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function defaultCliPath(): string {
  // dist/main.js, resolved from this module rather than from cwd.
  return new URL("./main.js", import.meta.url).pathname;
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
