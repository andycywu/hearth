import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, RunResult } from "@hearthkit/adapter-linux";
import { parseArgs } from "./args.js";
import { runSetup, systemdUnit } from "./setup.js";
import { configAsEnv, loadConfig } from "./config.js";

/**
 * Two boxes, as `hearth setup` would see them through the injected runner:
 * the Pi 3B from the first real report (PipeWire, cec-ctl, arecord, espeak-ng,
 * Node under ~/.local) and a bare machine with none of it.
 */
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const missing: RunResult = { code: 127, stdout: "", stderr: "command not found" };

const PI_FILES: Record<string, string> = {
  "/proc/device-tree/model": "Raspberry Pi 3 Model B Rev 1.2\0",
  "/proc/device-tree/compatible": "raspberrypi,3-model-b\0brcm,bcm2837\0",
  "/etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n',
};

const piRunner: Runner = async (cmd, args) => {
  switch (cmd) {
    case "wpctl": return ok("Volume: 0.20 [MUTED]\n");
    case "cec-ctl":
      if (args.includes("--version")) return ok("cec-ctl 1.30.1\n");
      // `-S` / topology: a TV at 0.0.0.0 and nothing else, as on 2026-10-05.
      return ok("Driver Info:\n\tPhysical Address : 3.0.0.0\n\n\tTopology:\n\n\t    0.0.0.0: TV\n");
    case "id": return ok("andycywu adm video audio\n");
    case "arecord": return ok("**** List of CAPTURE Hardware Devices ****\ncard 1: seeed4micvoicec [seeed-4mic-voicecard], device 0\n");
    case "espeak-ng": return ok("eSpeak NG text-to-speech: 1.52\n");
    default: return missing;
  }
};
const bareRunner: Runner = async () => missing;

async function io() {
  const out: string[] = []; const err: string[] = [];
  return { out, err, sink: { out: (t: string) => { out.push(t); }, err: (t: string) => { err.push(t); } } };
}
async function paths() {
  const dir = await mkdtemp(join(tmpdir(), "hearth-setup-"));
  return { configPath: join(dir, "config.json"), unitPath: join(dir, "hearth.service") };
}

describe("hearth setup", () => {
  it("refuses the mock, because there is nothing to set up", async () => {
    const { err, sink } = await io();
    expect(await runSetup(parseArgs(["setup"]), sink)).toBe(2);
    expect(err.join("")).toMatch(/--platform linux/);
  });

  it("describes the Pi the way the first report found it, and writes a config that makes flags unnecessary", async () => {
    const { out, sink } = await io();
    const p = await paths();
    const opts = parseArgs(["--platform", "linux", "setup", "--asr", "http://192.168.1.104:9000/v1"]);
    const code = await runSetup(opts, sink, {
      ...p, run: piRunner, readFile: async (f) => PI_FILES[f] ?? "",
      exists: async (f) => f === "/dev/cec0" || f === "/dev/spidev0.1",
      nodeVersion: "v26.8.2", nodePath: "/home/andycywu/.local/node/bin/node", cliPath: "/home/andycywu/hearth/apps/cli/dist/main.js",
    });
    expect(code).toBe(0);
    const page = out.join("");
    expect(page).toContain("This box: Raspberry Pi 3 Model B Rev 1.2 · Debian GNU/Linux 13 (trixie)");
    expect(page).toMatch(/✓ Volume & mute\s+through wireplumber/);
    expect(page).toMatch(/✓ HDMI-CEC\s+\/dev\/cec0 answers/);
    expect(page).toMatch(/✓ Voice\s+microphone \(arecord\) and speech \(espeak-ng\); transcription at http/);
    expect(page).toMatch(/✓ Status ring/);
    expect(page).toContain("listen on the microphone");

    const config = await loadConfig(p.configPath);
    expect(config).toMatchObject({
      platform: "linux", cec: "/dev/cec0", voice: true, leds: true, asrBaseUrl: "http://192.168.1.104:9000/v1",
    });
    // The whole point: the config, read back as environment, makes the next
    // plain `hearth "mute"` drive this box with voice and the ring on.
    const next = parseArgs(["mute"], configAsEnv(config));
    expect(next).toMatchObject({ platform: "linux", voice: true, leds: true, cec: "/dev/cec0", asrBaseUrl: "http://192.168.1.104:9000/v1" });
    expect(next.warnings).toEqual([]);

    const unit = await readFile(p.unitPath, "utf8");
    expect(unit).toContain("ExecStart=/home/andycywu/.local/node/bin/node /home/andycywu/hearth/apps/cli/dist/main.js --platform linux --yes --voice --leds");
  });

  it("says plainly what a box without voice can and cannot do, and writes no service for it", async () => {
    const { out, sink } = await io();
    const p = await paths();
    const code = await runSetup(parseArgs(["--platform", "linux", "setup"]), sink, {
      ...p, run: piRunner, readFile: async (f) => PI_FILES[f] ?? "", exists: async (f) => f === "/dev/cec0",
      nodeVersion: "v26.8.2",
    });
    expect(code).toBe(0);
    const page = out.join("");
    // Microphone and espeak-ng are there; what is missing is something that
    // turns speech into text, and the page says which flag fixes it.
    expect(page).toMatch(/~ Voice .*nothing turns speech into text/);
    expect(page).toMatch(/--asr http:\/\/<host>:<port>\/v1/);
    expect(page).toContain("No boot service yet");
    expect((await loadConfig(p.configPath)).voice).toBe(false);
    await expect(readFile(p.unitPath, "utf8")).rejects.toThrow();
  });

  it("names the apt packages a bare box is missing, and still exits 0 — it is usable, just deaf and mute", async () => {
    const { out, sink } = await io();
    const p = await paths();
    const code = await runSetup(parseArgs(["--platform", "linux", "setup"]), sink, {
      ...p, run: bareRunner, readFile: async () => "", exists: async () => false, nodeVersion: "v26.0.0",
    });
    expect(code).toBe(0);
    const page = out.join("");
    expect(page).toContain("sudo apt install v4l-utils");
    expect(page).toContain("cannot change anything about the room yet");
  });

  it("distinguishes 'no cec-ctl', 'no /dev/cec0' and 'not in the video group', because the fixes differ", async () => {
    const p = await paths();
    const run = (overrides: Partial<Record<string, RunResult>>): Runner => async (cmd, args) =>
      overrides[cmd] ? Promise.resolve(overrides[cmd]) : piRunner(cmd, args);

    let { out, sink } = await io();
    await runSetup(parseArgs(["--platform", "linux", "setup", "--no-save"]), sink,
      { ...p, run: run({}), readFile: async () => "", exists: async () => false, nodeVersion: "v26.0.0" });
    expect(out.join("")).toMatch(/\/dev\/cec0 does not exist[\s\S]*dtoverlay=vc4-kms-v3d/);

    ({ out, sink } = await io());
    await runSetup(parseArgs(["--platform", "linux", "setup", "--no-save"]), sink, {
      ...p, run: run({ id: ok("andycywu adm audio\n"), "cec-ctl": missing }), readFile: async () => "",
      exists: async (f) => f === "/dev/cec0", nodeVersion: "v26.0.0",
    });
    expect(out.join("")).toContain("cec-ctl is not installed");

    ({ out, sink } = await io());
    const noVideo: Runner = async (cmd, args) => {
      if (cmd === "id") return ok("andycywu adm audio\n");
      if (cmd === "cec-ctl" && !args.includes("--version")) return { code: 1, stdout: "", stderr: "Permission denied" };
      return piRunner(cmd, args);
    };
    await runSetup(parseArgs(["--platform", "linux", "setup", "--no-save"]), sink,
      { ...p, run: noVideo, readFile: async () => "", exists: async (f) => f === "/dev/cec0", nodeVersion: "v26.0.0" });
    expect(out.join("")).toMatch(/not in the video group[\s\S]*usermod -aG video/);
  });

  it("fails loudly on old Node, which is the one thing it cannot work around", async () => {
    const { out, sink } = await io();
    const p = await paths();
    const code = await runSetup(parseArgs(["--platform", "linux", "setup", "--no-save"]), sink,
      { ...p, run: bareRunner, readFile: async () => "", exists: async () => false, nodeVersion: "v22.22.0" });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/✗ Node .*v22\.22\.0[\s\S]*Node 26 or newer/);
  });

  it("--no-save shows the config and writes nothing", async () => {
    const { out, sink } = await io();
    const p = await paths();
    await runSetup(parseArgs(["--platform", "linux", "setup", "--no-save"]), sink,
      { ...p, run: bareRunner, readFile: async () => "", exists: async () => false, nodeVersion: "v26.0.0" });
    expect(out.join("")).toContain("nothing written: --no-save");
    expect(await loadConfig(p.configPath)).toEqual({});
  });
});

describe("the systemd unit", () => {
  it("pins Node's absolute path, because a service has no .profile", () => {
    const unit = systemdUnit({ node: "/home/pi/.local/node/bin/node", cli: "/home/pi/hearth/apps/cli/dist/main.js", voice: true, leds: false });
    expect(unit).toContain("ExecStart=/home/pi/.local/node/bin/node /home/pi/hearth/apps/cli/dist/main.js --platform linux --yes --voice");
    expect(unit).not.toContain("--leds");
    expect(unit).toContain("WantedBy=default.target");
  });
});
