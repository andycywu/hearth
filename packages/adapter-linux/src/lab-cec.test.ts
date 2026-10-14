import { describe, expect, it } from "vitest";
import type { Runner, RunResult } from "./run.js";
import {
  CEC_COMMANDS, diagnoseCec, findCommand, interpretTransmit, parseAdapterInfo, parseReplyFacts, parseTopologyFacts,
  runCecCommand, runCecRaw, validateRawArgs, type CecContext,
} from "./lab-cec.js";

/**
 * Output below is what `cec-ctl` v1.30.1 printed on the living-room Pi 3B
 * (kernel 6.18.50, 2026-10-12 and 2026-10-14), except the not-acknowledged
 * block, which is the one recorded on a Pi Zero W with no HDMI in
 * `cec.ts`. They are here because the lab's whole job is telling these apart,
 * and `cec-ctl` exits 0 for most of them.
 */
const INFO = (mask: string, logical: string, phys = "3.0.0.0") => `Driver Info:
\tDriver Name                : vc4_hdmi
\tAdapter Name               : vc4-hdmi
\tCapabilities               : 0x0000031e
\tPhysical Address           : ${phys}
\tLogical Address Mask       : ${mask}
\tLogical Addresses          : ${logical}
`;
const UNCONFIGURED = INFO("0x0000", "0 ");
const CONFIGURED = INFO("0x0010", "1 (Allow RC Passthrough)");
const UNCONFIGURED_TX = `\nAdapter is unconfigured, please configure it first.\n${UNCONFIGURED}`;
const POWER_REPLY = (state: string) => `${CONFIGURED}
Transmit from Playback Device 1 to TV (4 to 0):
CEC_MSG_GIVE_DEVICE_POWER_STATUS (0x8f)
\tSequence: 5 Tx Timestamp: 1000.1s
    Received from TV (0):
\tpwr-state: ${state} (0x00)
`;
const NOT_ACKED = `Transmit from Playback Device 1 to TV (4 to 0):
GIVE_DEVICE_POWER_STATUS (0x8f)
\tSequence: 20 Tx Timestamp: 22142.328382s
\tTx, Not Acknowledged (4), Max Retries
`;
const ACKED_NO_REPLY = `Transmit from Playback Device 1 to TV (4 to 0):
CEC_MSG_GIVE_DEVICE_POWER_STATUS (0x8f)
\tSequence: 6 Tx Timestamp: 1001.1s
`;
const ABORTED = `Transmit from Playback Device 1 to TV (4 to 0):
CEC_MSG_GIVE_AUDIO_STATUS (0x71)
\tSequence: 7 Tx Timestamp: 1002.1s
    Received from TV (0):
    FEATURE_ABORT (0x00):
\tabort-msg: 113 (0x71, GIVE_AUDIO_STATUS)
\tabort-reason: unrecognized-op (0x00)
`;

const ok = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

/** A fake adapter that behaves like the real one: unconfigured until `--playback`. */
function bus(o: { claimed?: boolean; tx?: (args: string[]) => string; power?: string[]; failVersion?: boolean } = {}) {
  const state = { claimed: o.claimed ?? false, calls: [] as string[], power: [...(o.power ?? ["on"])] };
  const run: Runner = async (cmd, args) => {
    state.calls.push([cmd, ...args].join(" "));
    if (cmd === "vcgencmd") return ok("throttled=0x0\n");
    if (args[0] === "--version") return o.failVersion ? { code: 127, stdout: "", stderr: "not found" } : ok("cec-ctl 1.30.1\n");
    const a = args.slice(2);                     // drop -d <dev>
    if (a.length === 0) return ok(state.claimed ? CONFIGURED : UNCONFIGURED);
    if (a[0] === "--playback") { state.claimed = true; return ok(CONFIGURED); }
    if (!state.claimed) return ok(UNCONFIGURED_TX);
    if (a.includes("--give-device-power-status")) {
      const s = state.power.length > 1 ? state.power.shift()! : state.power[0]!;
      return ok(POWER_REPLY(s));
    }
    return ok(o.tx ? o.tx(a) : ACKED_NO_REPLY.replace("GIVE_DEVICE_POWER_STATUS", "X"));
  };
  return { run, state };
}
const ctxOf = (run: Runner, extra: Partial<CecContext> = {}): CecContext => ({ device: "/dev/cec0", run, ...extra });

describe("reading cec-ctl", () => {
  it("tells an unconfigured adapter from a configured one by its logical address mask", () => {
    expect(parseAdapterInfo(UNCONFIGURED)).toMatchObject({ physical: "3.0.0.0", logical: [] });
    expect(parseAdapterInfo(CONFIGURED)).toMatchObject({ physical: "3.0.0.0", logical: [4] });
    expect(parseAdapterInfo(INFO("0x0001", "1", "f.f.f.f")).physical).toBe("f.f.f.f");
  });

  it("separates the six things that all look like 'the TV does not respond'", () => {
    expect(interpretTransmit(UNCONFIGURED_TX, 0, true)).toBe("unconfigured");     // note: exit code 0
    expect(interpretTransmit(NOT_ACKED, 0, true)).toBe("not-acknowledged");        // exit code 0 too
    expect(interpretTransmit(ACKED_NO_REPLY, 0, true)).toBe("no-reply");
    expect(interpretTransmit(POWER_REPLY("on"), 0, true)).toBe("reply");
    expect(interpretTransmit(ABORTED, 0, true)).toBe("feature-abort");
    expect(interpretTransmit(ACKED_NO_REPLY, 0, false)).toBe("sent");
    expect(interpretTransmit("cec-ctl: unrecognized option '--nope'", 1, false)).toBe("error");
  });

  it("does not take a FEATURE_ABORT in the message it sent for one it received", () => {
    const sentOnly = "Transmit from Playback Device 1 to TV (4 to 0):\nFEATURE_ABORT (0x00)\n\tSequence: 1\n";
    expect(interpretTransmit(sentOnly, 0, false)).toBe("sent");
  });

  it("reads the bus tree, and says reading the adapter sent nothing to the TV", async () => {
    const TOPOLOGY = `${CONFIGURED}\n\tTopology:\n\n\t    0.0.0.0: TV\n\t        3.0.0.0: Playback Device 1\n`;
    expect(parseTopologyFacts(TOPOLOGY)).toEqual({ "0.0.0.0": "TV", "3.0.0.0": "Playback Device 1" });
    expect(parseTopologyFacts(NOT_ACKED)).toEqual({});

    const run: Runner = async (_cmd, args) => ({ code: 0, stdout: args.length > 2 ? TOPOLOGY : CONFIGURED, stderr: "" });
    const r = await runCecCommand(ctxOf(run), findCommand("topology")!);
    expect(r.facts).toMatchObject({ "0.0.0.0": "TV", "physical-address": "3.0.0.0" });
    expect(r.summary).toBe("Read from this box's adapter; nothing was sent to the TV.");
  });

  it("reads the reply's own fields, not the transmit's bookkeeping", () => {
    expect(parseReplyFacts(POWER_REPLY("standby"))).toEqual({ "pwr-state": "standby (0x00)" });
    expect(parseReplyFacts(ABORTED)).toMatchObject({ "abort-reason": "unrecognized-op (0x00)" });
    expect(parseReplyFacts(NOT_ACKED)).toEqual({});
  });
});

describe("running a command", () => {
  it("claims a logical address first on a fresh boot, and shows that it did", async () => {
    const b = bus({ claimed: false });
    const r = await runCecCommand(ctxOf(b.run), findCommand("tv-power-status")!);
    expect(r.steps.map((s) => s.cmdline)).toEqual([
      "cec-ctl -d /dev/cec0 --playback",
      "cec-ctl -d /dev/cec0 --to 0 --give-device-power-status",
    ]);
    expect(r).toMatchObject({ verdict: "reply", facts: { "pwr-state": "on (0x00)" } });
  });

  it("does not reconfigure an adapter that already has an address", async () => {
    const b = bus({ claimed: true });
    await runCecCommand(ctxOf(b.run), findCommand("tv-power-status")!);
    expect(b.state.calls.some((c) => c.includes("--playback"))).toBe(false);
  });

  it("can be told not to claim, and then reports the adapter as unconfigured instead of papering over it", async () => {
    const b = bus({ claimed: false });
    const r = await runCecCommand(ctxOf(b.run), findCommand("tv-power-status")!, { claim: false });
    expect(r.verdict).toBe("unconfigured");
    expect(r.summary).toMatch(/no logical address/);
  });

  it("aims at the address it is given", async () => {
    const b = bus({ claimed: true });
    const r = await runCecCommand(ctxOf(b.run), findCommand("tv-vendor")!, { target: 5 });
    expect(r.steps.at(-1)!.cmdline).toBe("cec-ctl -d /dev/cec0 --to 5 --give-device-vendor-id");
    expect(r.target).toBe(5);
  });

  it("sends a key as pressed then released, and calls it sent — a key has no acknowledgement of effect", async () => {
    const b = bus({ claimed: true });
    const r = await runCecCommand(ctxOf(b.run), findCommand("key-volume-up")!);
    expect(r.steps.map((s) => s.cmdline.replace("cec-ctl -d /dev/cec0 ", ""))).toEqual([
      "--to 0 --user-control-pressed ui-cmd=volume-up",
      "--to 0 --user-control-released",
    ]);
    expect(r.verdict).toBe("sent");
    expect(r.readBack).toBeUndefined();
  });

  it("fills in this adapter's own physical address where a command names it", async () => {
    const b = bus({ claimed: true });
    const r = await runCecCommand(ctxOf(b.run), findCommand("active-source")!);
    expect(r.steps.at(-1)!.cmdline).toBe("cec-ctl -d /dev/cec0 --active-source phys-addr=3.0.0.0");
  });

  it("reports a nacked transmit as not-acknowledged, never as sent", async () => {
    const b = bus({ claimed: true, tx: () => NOT_ACKED });
    const r = await runCecCommand(ctxOf(b.run), findCommand("tv-standby")!);
    expect(r.verdict).toBe("not-acknowledged");
    expect(r.readBack).toBeUndefined();                 // nothing to read back from a TV nobody reached
    expect(r.summary).toMatch(/Nobody acknowledged/);
  });
});

describe("read-back: sent is not done", () => {
  it("says verified only when the TV itself reports the state", async () => {
    let t = 0;
    const b = bus({ claimed: true, power: ["on", "on", "standby"] });
    const r = await runCecCommand(ctxOf(b.run, { now: () => t, sleep: async (ms) => { t += ms; } }), findCommand("tv-standby")!);
    expect(r.readBack).toMatchObject({ wanted: "standby", reached: true, last: "standby" });
    expect(r.summary).toMatch(/verified by read-back/);
  });

  it("says the TV accepted the message and did not do it, when it never reports the state", async () => {
    let t = 0;
    const b = bus({ claimed: true, power: ["on"] });
    const r = await runCecCommand(ctxOf(b.run, { now: () => t, sleep: async (ms) => { t += ms; } }), findCommand("tv-standby")!, { readBackMs: 3_000 });
    expect(r.readBack).toMatchObject({ wanted: "standby", reached: false, last: "on" });
    expect(r.summary).toMatch(/did NOT report "standby".*did not do it/);
  });
});

describe("the raw box", () => {
  it("accepts plain cec-ctl flags", () => {
    expect(validateRawArgs(["--to", "0", "--user-control-pressed", "ui-cmd=volume-up"])).toBeUndefined();
    expect(validateRawArgs(["--active-source", "phys-addr=3.0.0.0"])).toBeUndefined();
  });

  it("refuses anything that is not one — this is a web page's text box", () => {
    for (const bad of [["--standby;reboot"], ["$(id)"], ["--to", "0 && ls"], ["`x`"], ["-d", "/dev/cec1"], ["--device=/dev/null"], ["--store-sg"], ["a b"], []]) {
      expect(validateRawArgs(bad), JSON.stringify(bad)).toBeTypeOf("string");
    }
  });

  it("never runs a refused command", async () => {
    const b = bus({ claimed: true });
    const r = await runCecRaw(ctxOf(b.run), ["--standby;reboot"]);
    expect(r.verdict).toBe("error");
    expect(b.state.calls).toEqual([]);
  });

  it("runs a plain one and reads a reply if the output shows one", async () => {
    const b = bus({ claimed: true });
    const r = await runCecRaw(ctxOf(b.run), ["--to", "0", "--give-device-power-status"]);
    expect(r.verdict).toBe("reply");
    expect(r.steps.at(-1)!.cmdline).toBe("cec-ctl -d /dev/cec0 --to 0 --give-device-power-status");
  });
});

describe("the catalogue", () => {
  it("has unique ids, and an explanation for everything that changes the room", () => {
    const ids = CEC_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CEC_COMMANDS) expect(c.explain.length, c.id).toBeGreaterThan(20);
  });

  it("only attaches a read-back where the power state can say whether it worked", () => {
    for (const c of CEC_COMMANDS.filter((c) => c.readBack)) expect(c.group, c.id).toBe("power");
  });
});

describe("diagnosing from the cable up", () => {
  const io = (over: Partial<NonNullable<Parameters<typeof diagnoseCec>[1]>> = {}) => ({
    drm: async () => [{ name: "card0-HDMI-A-1", status: "connected" }],
    throttled: async () => "throttled=0x0",
    deviceExists: async () => true,
    ...over,
  });
  const layer = (d: Awaited<ReturnType<typeof diagnoseCec>>, name: string) => d.steps.find((s) => s.layer === name)!;

  it("passes a healthy bus, layer by layer", async () => {
    const b = bus({ claimed: true });
    const d = await diagnoseCec(ctxOf(b.run), io());
    expect(d.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(layer(d, "TV on the bus").detail).toMatch(/power on/);
    expect(d.firstProblem).toBeUndefined();
  });

  it("on a fresh boot it claims an address and says that is what happened — the 2026-10-14 case", async () => {
    const b = bus({ claimed: false });
    const d = await diagnoseCec(ctxOf(b.run), io());
    expect(layer(d, "Logical address")).toMatchObject({ status: "warn" });
    expect(layer(d, "Logical address").detail).toMatch(/fresh boot has none.*claimed 4/);
    expect(layer(d, "TV on the bus").status).toBe("ok");
    expect(d.firstProblem?.layer).toBe("Logical address");
  });

  it("stops at a dead cable and does not blame the TV's settings", async () => {
    const b = bus({ claimed: true });
    const d = await diagnoseCec(ctxOf(b.run), io({ drm: async () => [{ name: "card0-HDMI-A-1", status: "disconnected" }] }));
    expect(d.firstProblem?.layer).toBe("HDMI cable");
    expect(d.firstProblem?.fix).toMatch(/hot-plug/);
  });

  it("calls f.f.f.f what it is: the TV never said where the port sits", async () => {
    const run: Runner = async (cmd, args) => cmd === "vcgencmd" ? ok("throttled=0x0") : args[0] === "--version" ? ok("cec-ctl 1.30.1") : ok(INFO("0x0000", "0 ", "f.f.f.f"));
    const d = await diagnoseCec(ctxOf(run), io());
    expect(layer(d, "Physical address")).toMatchObject({ status: "fail" });
    expect(layer(d, "Physical address").detail).toMatch(/f\.f\.f\.f/);
  });

  it("says a TV that nobody can reach needs its CEC setting turned on — and only then", async () => {
    const b = bus({ claimed: true });
    const run: Runner = async (cmd, args) => (args.includes("--give-device-power-status") ? ok(NOT_ACKED) : b.run(cmd, args));
    const d = await diagnoseCec(ctxOf(run), io());
    expect(layer(d, "TV on the bus")).toMatchObject({ status: "fail" });
    expect(layer(d, "TV on the bus").fix).toMatch(/EasyLink|Anynet/);
  });

  it("names a missing cec-ctl and skips the rest", async () => {
    const b = bus({ failVersion: true });
    const d = await diagnoseCec(ctxOf(b.run), io());
    expect(d.firstProblem).toMatchObject({ layer: "cec-ctl", fix: "sudo apt install v4l-utils" });
    expect(d.steps.filter((s) => s.status === "skipped").length).toBeGreaterThan(3);
  });

  it("names a missing adapter, and a power problem as a warning that colours everything under it", async () => {
    const b = bus({ claimed: true });
    const gone = await diagnoseCec(ctxOf(b.run), io({ deviceExists: async () => false }));
    expect(gone.firstProblem).toMatchObject({ layer: "Adapter", status: "fail" });

    const weak = await diagnoseCec(ctxOf(b.run), io({ throttled: async () => "throttled=0x50005" }));
    expect(layer(weak, "Power")).toMatchObject({ status: "warn" });
    expect(layer(weak, "TV on the bus").status).toBe("ok");
  });
});
