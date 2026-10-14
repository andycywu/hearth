import { request } from "node:http";
import { describe, expect, it } from "vitest";
import type { Runner, SpawnedProcess, AudioLab } from "@hearthkit/adapter-linux";
import { parseArgs } from "./args.js";
import { createLab, launcherEntry, type Lab } from "./lab.js";
import { runCecTool, runLab, windowCommand } from "./lab-run.js";

/** What `cec-ctl` printed on the Pi (2026-10-14); see packages/adapter-linux/src/lab-cec.test.ts. */
const INFO = (mask: string, logical: string) => `Driver Info:\n\tPhysical Address           : 3.0.0.0\n\tLogical Address Mask       : ${mask}\n\tLogical Addresses          : ${logical}\n`;
const CONFIGURED = INFO("0x0010", "1 (Allow RC Passthrough)");
const POWER_REPLY = `${CONFIGURED}Transmit from Playback Device 1 to TV (4 to 0):\n    Received from TV (0):\n\tpwr-state: on (0x00)\n`;

function scriptedBus(): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "vcgencmd") return { code: 0, stdout: "throttled=0x0\n", stderr: "" };
    if (args[0] === "--version") return { code: 0, stdout: "cec-ctl 1.30.1\n", stderr: "" };
    const a = args.slice(2);
    if (a.length === 0) return { code: 0, stdout: CONFIGURED, stderr: "" };
    if (a.includes("--give-device-power-status")) return { code: 0, stdout: POWER_REPLY, stderr: "" };
    return { code: 0, stdout: "Transmit from Playback Device 1 to TV (4 to 0):\n\tSequence: 1\n", stderr: "" };
  };
  return { run, calls };
}

function fakeAudio(): AudioLab {
  let kept: Uint8Array | undefined;
  return {
    last: () => kept,
    record: async () => { kept = new Uint8Array([82, 73, 70, 70]); return { ok: true, levels: { seconds: 4, rms: 0.01, peak: 0.1, rmsDb: -40, peakDb: -20 }, cmdline: "arecord -D default ..." }; },
    play: async () => ({ ok: true, cmdline: "aplay -q x.wav" }),
    say: async (t) => ({ ok: true, cmdline: `espeak-ng -- ${t}` }),
  };
}

async function started(extra: Partial<Parameters<typeof createLab>[0]> = {}) {
  const { run } = scriptedBus();
  const lab = createLab({ token: "tok123", cec: { device: "/dev/cec0", run }, audio: fakeAudio(), throttled: async () => "0x0", ...extra });
  const port = await lab.listen(0);
  const get = (path: string, token = "tok123") => fetch(`http://127.0.0.1:${port}${path}${path.includes("?") ? "&" : "?"}t=${token}`);
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}?t=tok123`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { lab, port, get, post };
}

describe("lab server: who may talk to a television", () => {
  it("serves the page to someone holding the token", async () => {
    const t = await started();
    const r = await t.get("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Hearth Lab");
    await t.lab.close();
  });

  it("refuses a missing or wrong token on every route", async () => {
    const t = await started();
    for (const path of ["/", "/api/state", "/api/audio/last.wav"]) {
      expect((await fetch(`http://127.0.0.1:${t.port}${path}`)).status, path).toBe(403);
      expect((await t.get(path, "nope")).status, path).toBe(403);
    }
    expect((await fetch(`http://127.0.0.1:${t.port}/api/run`, { method: "POST", body: "{}" })).status).toBe(403);
    await t.lab.close();
  });

  it("refuses a request whose Host is not the loopback — DNS rebinding from another tab", async () => {
    const t = await started();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: t.port, path: "/api/state?t=tok123", headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject); req.end();
    });
    expect(status).toBe(403);
    await t.lab.close();
  });

  it("binds only to the loopback unless asked", async () => {
    const t = await started();
    expect((t.lab.server.address() as { address: string }).address).toBe("127.0.0.1");
    await t.lab.close();
  });
});

describe("lab server: what it does", () => {
  it("reports the adapter, the power flags and the command catalogue — without the arguments it would run", async () => {
    const t = await started();
    const s = await (await t.get("/api/state")).json() as { device: string; adapter: { physical: string; logical: number[] }; throttled: string; commands: Array<Record<string, unknown>> };
    expect(s).toMatchObject({ device: "/dev/cec0", adapter: { physical: "3.0.0.0", logical: [4] }, throttled: "0x0" });
    expect(s.commands.find((c) => c.id === "tv-standby")).toMatchObject({ changesState: true, group: "power" });
    expect(s.commands.every((c) => !("steps" in c))).toBe(true);
    await t.lab.close();
  });

  it("runs a catalogue command and returns the verdict with the exact command line", async () => {
    const t = await started();
    const r = await (await t.post("/api/run", { id: "tv-power-status", target: 0 })).json() as { verdict: string; facts: Record<string, string>; steps: Array<{ cmdline: string }> };
    expect(r.verdict).toBe("reply");
    expect(r.facts["pwr-state"]).toBe("on (0x00)");
    expect(r.steps.at(-1)!.cmdline).toBe("cec-ctl -d /dev/cec0 --to 0 --give-device-power-status");
    await t.lab.close();
  });

  it("rejects an unknown command and a target that is not a logical address", async () => {
    const t = await started();
    expect((await t.post("/api/run", { id: "rm-rf" })).status).toBe(400);
    expect((await t.post("/api/run", { id: "tv-power-status", target: 99 })).status).toBe(400);
    await t.lab.close();
  });

  it("will not pass a shell word through the raw box", async () => {
    const bus = scriptedBus();
    const t = await started({ cec: { device: "/dev/cec0", run: bus.run } });
    const r = await (await t.post("/api/raw", { args: ["--standby;reboot"] })).json() as { verdict: string };
    expect(r.verdict).toBe("error");
    expect(bus.calls.some((c) => c.includes("reboot"))).toBe(false);
    await t.lab.close();
  });

  it("diagnoses", async () => {
    const t = await started();
    const d = await (await t.post("/api/diagnose", {})).json() as { steps: Array<{ layer: string; status: string }> };
    expect(d.steps.map((s) => s.layer)).toContain("TV on the bus");
    await t.lab.close();
  });

  it("runs Hearth's own transport and shows what it found", async () => {
    const t = await started({ transport: () => ({ available: async () => true, scan: async () => [], powerStatus: async () => "on", wake: async () => {}, standby: async () => {}, selectSource: async () => {} }) });
    const r = await (await t.post("/api/hearth-view", {})).json() as { ok: boolean; summary: string };
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/no devices past this box.*power: on/);
    await t.lab.close();
  });

  it("records, then serves the clip it kept, and 404s before there is one", async () => {
    const t = await started();
    expect((await t.get("/api/audio/last.wav")).status).toBe(404);
    const rec = await (await t.post("/api/audio/record", { seconds: 4 })).json() as { ok: boolean; levels: { peakDb: number } };
    expect(rec).toMatchObject({ ok: true, levels: { peakDb: -20 } });
    const wav = await t.get("/api/audio/last.wav");
    expect(wav.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await wav.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
    await t.lab.close();
  });

  it("streams the bus monitor line by line, and says when it ends", async () => {
    const proc: SpawnedProcess = {
      stdout: (async function* () { yield new TextEncoder().encode("Received from TV (0) to all (15): ACTIVE_SOURCE\n  phys-addr: 0.0.0.0\n"); })(),
      stderr: () => "", kill: () => {}, exit: Promise.resolve(0),
    };
    const t = await started({ spawn: () => proc });
    const text = await (await t.get("/api/monitor")).text();
    expect(text).toContain('data: "Received from TV (0) to all (15): ACTIVE_SOURCE"');
    expect(text).toContain('data: "  phys-addr: 0.0.0.0"');
    expect(text).toContain("event: fault");
    expect(text).toContain("ended (exit 0)");
    await t.lab.close();
  });

  it("monitor mode is root-only: it retries once with sudo -n, and says what to type if that wants a password", async () => {
    const calls: string[] = [];
    const proc = (text: string, stderr = ""): SpawnedProcess => ({
      stdout: (async function* () { yield new TextEncoder().encode(text); })(), stderr: () => stderr, kill: () => {}, exit: Promise.resolve(1),
    });
    const t = await started({
      spawn: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        return cmd === "sudo" ? proc("", "sudo: a password is required") : proc("Selecting monitor mode failed, you may have to run this as root.\n");
      },
    });
    const text = await (await t.get("/api/monitor")).text();
    expect(calls).toEqual(["cec-ctl -d /dev/cec0 --monitor", "sudo -n cec-ctl -d /dev/cec0 --monitor"]);
    expect(text).toContain("monitor mode needs root; trying sudo -n");
    expect(text).toContain("In a terminal on the Pi run: sudo cec-ctl -d /dev/cec0 --monitor");
    await t.lab.close();
  });

  it("refuses a request body that is too large", async () => {
    const t = await started();
    const r = await t.post("/api/raw", { args: ["x".repeat(20_000)] });
    expect(r.status).toBe(500);
    await t.lab.close();
  });
});

describe("hearth lab (the window)", () => {
  const out: string[] = [];
  const io = () => { out.length = 0; return { out: (t: string) => { out.push(t); }, err: (t: string) => { out.push(t); } }; };

  it("prints the address with its token, opens a window once, and shuts the server on interrupt", async () => {
    let closed = false;
    const lab = { token: "abc", server: undefined as never, listen: async () => 8421, close: async () => { closed = true; } } as Lab;
    const opened: string[] = [];
    let interrupt!: () => void;
    const run = runLab(parseArgs(["lab"], {}), io(), { lab, openWindow: (u) => opened.push(u), interrupted: new Promise<void>((r) => { interrupt = r; }) });
    await new Promise((r) => setTimeout(r, 5));
    expect(out.join("")).toContain("http://127.0.0.1:8421/?t=abc");
    expect(opened).toEqual(["http://127.0.0.1:8421/?t=abc"]);
    interrupt();
    expect(await run).toBe(0);
    expect(closed).toBe(true);
  });

  it("--no-open leaves the window to you", async () => {
    const lab = { token: "abc", server: undefined as never, listen: async () => 8420, close: async () => {} } as Lab;
    const opened: string[] = [];
    await runLab(parseArgs(["lab", "--no-open"], {}), io(), { lab, openWindow: (u) => opened.push(u), interrupted: Promise.resolve() });
    expect(opened).toEqual([]);
  });

  it("says plainly when the port is taken", async () => {
    const lab = { token: "abc", server: undefined as never, listen: async () => { throw new Error("EADDRINUSE"); }, close: async () => {} } as Lab;
    expect(await runLab(parseArgs(["lab", "--port", "8420"], {}), io(), { lab })).toBe(1);
    expect(out.join("")).toMatch(/cannot listen on port 8420: EADDRINUSE/);
  });

  it("starts the browser as an app window on the Pi's own desktop, even from ssh", () => {
    const w = windowCommand("http://127.0.0.1:8420/?t=abc", {}, "/home/pi");
    expect(w.args[0]).toBe("--app=http://127.0.0.1:8420/?t=abc");
    expect(w.args).toContain("--user-data-dir=/home/pi/.config/hearth/lab-profile");
    expect(w.args).toContain("--password-store=basic");         // else a keyring-password dialog covers the window
    expect(w.args).toContain("--ozone-platform=wayland");       // without it Chromium tries X11 on a Wayland-only desktop and exits
    expect(w.env.WAYLAND_DISPLAY).toBe("wayland-0");
    expect(w.env.XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
    expect(windowCommand("u", { WAYLAND_DISPLAY: "wayland-1" }).env.WAYLAND_DISPLAY).toBe("wayland-1");
  });

  it("--install-launcher writes a desktop entry to the menu and the desktop", async () => {
    const written: Record<string, string> = {};
    const code = await runLab(parseArgs(["lab", "--install-launcher"], {}), io(), {
      home: "/home/pi", node: "/home/pi/.local/node/bin/node", cli: "/home/pi/hearth/apps/cli/dist/main.js",
      write: async (p, t) => { written[p] = t; },
    });
    expect(code).toBe(0);
    expect(Object.keys(written)).toEqual(["/home/pi/.local/share/applications/hearth-lab.desktop", "/home/pi/Desktop/hearth-lab.desktop"]);
    expect(written["/home/pi/Desktop/hearth-lab.desktop"]).toContain("Exec=/home/pi/.local/node/bin/node /home/pi/hearth/apps/cli/dist/main.js lab");
    expect(launcherEntry({ node: "n", cli: "c" })).toContain("Name=Hearth Lab");
  });
});

describe("hearth cec (the same commands, in a terminal)", () => {
  const io = () => { const out: string[] = []; return { out, io: { out: (t: string) => { out.push(t); }, err: (t: string) => { out.push(t); } } }; };
  const ctx = () => ({ device: "/dev/cec0", run: scriptedBus().run });

  it("is parsed with its words, and --target", () => {
    expect(parseArgs(["cec", "tv-power-status", "--target", "5"])).toMatchObject({ cecTool: ["tv-power-status"], target: 5, commands: [] });
    expect(parseArgs(["cec", "x", "--target", "99"]).errors[0]).toMatch(/0–14/);
  });

  it("lists the commands and marks the ones that change the TV", async () => {
    const o = io();
    expect(await runCecTool(parseArgs(["cec", "list"]), ["list"], o.io)).toBe(0);
    const text = o.out.join("");
    expect(text).toMatch(/tv-power-status\s+\s*TV: power status/);
    expect(text).toMatch(/tv-standby\s+⚠ TV: standby/);
  });

  it("sends a read-only command, shows the command line and the verdict, and exits 0 on a reply", async () => {
    const o = io();
    expect(await runCecTool(parseArgs(["cec", "tv-power-status"]), ["tv-power-status"], o.io, { cec: ctx() })).toBe(0);
    expect(o.out.join("")).toContain("$ cec-ctl -d /dev/cec0 --to 0 --give-device-power-status");
    expect(o.out.join("")).toContain("→ reply:");
    expect(o.out.join("")).toContain("pwr-state: on (0x00)");
  });

  it("will not change the TV without --yes", async () => {
    const o = io();
    const bus = scriptedBus();
    expect(await runCecTool(parseArgs(["cec", "tv-standby"]), ["tv-standby"], o.io, { cec: { device: "/dev/cec0", run: bus.run } })).toBe(2);
    expect(o.out.join("")).toMatch(/changes the TV.*--yes/);
    expect(bus.calls.some((c) => c.includes("--standby"))).toBe(false);
  });

  it("exits 1 when a standby was sent and the TV did not report it", async () => {
    const o = io();
    const bus = scriptedBus();                       // always answers "on", so standby is never reached
    const fast = { device: "/dev/cec0", run: bus.run, now: (() => { let t = 0; return () => (t += 20_000); })(), sleep: async () => {} };
    expect(await runCecTool(parseArgs(["cec", "tv-standby", "--yes"]), ["tv-standby"], o.io, { cec: fast })).toBe(1);
    expect(o.out.join("")).toMatch(/NOT verified/);
  });

  it("names an unknown command", async () => {
    const o = io();
    expect(await runCecTool(parseArgs(["cec", "dance"]), ["dance"], o.io)).toBe(2);
    expect(o.out.join("")).toMatch(/unknown CEC command "dance"/);
  });

  it("send passes plain flags through and refuses the rest", async () => {
    const o = io();
    expect(await runCecTool(parseArgs(["cec", "send"]), ["send", "--to", "0", "--give-device-power-status"], o.io, { cec: ctx() })).toBe(0);
    const bad = io();
    expect(await runCecTool(parseArgs(["cec", "send"]), ["send", "--standby;reboot"], bad.io, { cec: ctx() })).toBe(1);
    expect(bad.out.join("")).toMatch(/not a plain cec-ctl flag/);
  });

  it("diagnose prints the layers and exits 0 when none has failed", async () => {
    const o = io();
    const c = { ...ctx() };
    const code = await runCecTool(parseArgs(["cec", "diagnose"]), ["diagnose"], o.io, { cec: c });
    expect(o.out.join("")).toMatch(/TV on the bus/);
    expect([0, 1]).toContain(code);                  // the DRM connector is read from this machine's /sys, which a CI box may not have
  });
});
