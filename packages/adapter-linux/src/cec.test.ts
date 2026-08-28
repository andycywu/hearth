import { describe, it, expect } from "vitest";
import { isTvUnsupported } from "@hearthkit/platform-api";
import { createCecSource } from "@hearthkit/adapter-cec";
import { createLinuxCecTransport, parsePowerStatus, parseTopology } from "./cec.js";
import type { Runner, RunResult } from "./run.js";

/**
 * The fixtures below are written to the output shape `cec-ctl` documents. They
 * have **not** been recorded from a real adapter — nobody here has one — and
 * that is stated rather than glossed, because a fixture is only as good as where
 * it came from and this one is a careful reading of a manual.
 *
 * `node tools/verify-cec.mjs` on a machine with `/dev/cec0` prints a real
 * transcript ready to paste in here. The first person to run it should replace
 * these, and any difference they find is a bug in the parser, not in their TV.
 */

const TOPOLOGY = `
Driver Info:
	Driver Name                : vc4
	Adapter Name               : vc4
	Physical Address           : 2.0.0.0
	CEC Version                : 2.0
	Vendor ID                  : 0x000c03 (HDMI)
	OSD Name                   : 'Playback'

Topology:

	System Information for device 0 (TV) from device 4 (Playback Device 1):
		CEC Version                : 1.4
		Physical Address           : 0.0.0.0
		Primary Device Type        : TV
		Vendor ID                  : 0x000c03 (HDMI)
		OSD Name                   : 'TV'
		Menu Language              : eng
		Power Status               : On

	System Information for device 5 (Audio System) from device 4 (Playback Device 1):
		CEC Version                : 1.4
		Physical Address           : 3.0.0.0
		Primary Device Type        : Audio System
		Vendor ID                  : 0x0005cd (Denon)
		OSD Name                   : 'Denon AVR'
		Power Status               : Standby

	System Information for device 8 (Playback Device 2) from device 4 (Playback Device 1):
		CEC Version                : 1.4
		Physical Address           : 3.1.0.0
		Primary Device Type        : Playback
		Vendor ID                  : 0x0010fa (Apple)
		OSD Name                   : 'Apple TV'
		Power Status               : Standby
`;

const POWER_ON = `
Transmit from Playback Device 1 to Playback Device 2 (4 to 8):
CEC_MSG_GIVE_DEVICE_POWER_STATUS (0x8f)
	Sequence: 12 Tx Timestamp: 12345.678s Rx Timestamp: 12345.912s
	Received from Playback Device 2 (8):
CEC_MSG_REPORT_POWER_STATUS (0x90):
	pwr-state: on (0x00)
`;

const NO_REPLY = `
Transmit from Playback Device 1 to Playback Device 2 (4 to 8):
CEC_MSG_GIVE_DEVICE_POWER_STATUS (0x8f)
	Sequence: 13 Tx Timestamp: 12350.101s Rx Timestamp: -
	Timeout waiting for reply
`;

/** A runner that answers from a table and records what it was asked. */
function fakeRunner(answers: Record<string, Partial<RunResult>>): Runner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const key = Object.keys(answers).find((k) => line.includes(k));
    const answer = key ? answers[key]! : {};
    return { code: answer.code ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  }) as Runner & { calls: string[] };
  run.calls = calls;
  return run;
}

describe("parsing cec-ctl --show-topology", () => {
  it("reads every device on the bus, with the fields it actually answered", () => {
    const devices = parseTopology(TOPOLOGY);
    expect(devices).toEqual([
      { logical: 0, physical: "0.0.0.0", osdName: "TV", vendorId: "HDMI" },
      { logical: 5, physical: "3.0.0.0", osdName: "Denon AVR", vendorId: "Denon" },
      { logical: 8, physical: "3.1.0.0", osdName: "Apple TV", vendorId: "Apple" },
    ]);
  });

  it("does not mistake the driver's own block for a device", () => {
    // The `Driver Info` header carries a Physical Address and an OSD Name too,
    // and it is *this* adapter, not something on the bus. Only blocks under
    // "System Information for device N" count.
    expect(parseTopology(TOPOLOGY).map((d) => d.logical)).not.toContain(4);
  });

  it("leaves out a field the device declined to answer", () => {
    const devices = parseTopology(`
	System Information for device 4 (Playback Device 1) from device 0 (TV):
		Physical Address           : 1.0.0.0
`);
    expect(devices).toEqual([{ logical: 4, physical: "1.0.0.0" }]);
  });

  it("keeps the hex vendor id when cec-ctl has no name for it", () => {
    const devices = parseTopology(`
	System Information for device 4 (Playback Device 1) from device 0 (TV):
		Vendor ID                  : 0x00903e
`);
    expect(devices[0]?.vendorId).toBe("0x00903e");
  });

  it("treats an empty OSD name as no name", () => {
    // A device that answers `''` has not told us what it is called, and
    // `osdName: ""` downstream becomes a device named nothing at all.
    const devices = parseTopology(`
	System Information for device 4 (Playback Device 1) from device 0 (TV):
		OSD Name                   : ''
`);
    expect(devices[0]?.osdName).toBeUndefined();
  });

  it("returns nothing for output with no topology in it", () => {
    expect(parseTopology("")).toEqual([]);
    expect(parseTopology("Driver Info:\n\tDriver Name : vc4\n")).toEqual([]);
  });
});

describe("parsing a power-status reply", () => {
  it("reads the four states", () => {
    expect(parsePowerStatus(POWER_ON)).toBe("on");
    expect(parsePowerStatus("pwr-state: standby (0x01)")).toBe("standby");
    expect(parsePowerStatus("pwr-state: to-on (0x02)")).toBe("to_on");
    expect(parsePowerStatus("pwr-state: to-standby (0x03)")).toBe("to_standby");
  });

  it("falls back to the raw operand when there is no name", () => {
    expect(parsePowerStatus("pwr-state: (0x01)")).toBe("standby");
  });

  it("says unknown when the device did not answer", () => {
    // The case that matters most: "didn't say" is not "off". An agent that
    // reads silence as standby helpfully wakes a console that was already on.
    expect(parsePowerStatus(NO_REPLY)).toBe("unknown");
    expect(parsePowerStatus("")).toBe("unknown");
  });
});

describe("the Linux CEC transport", () => {
  it("is unavailable when there is no adapter, and says so as unsupported", async () => {
    const run = fakeRunner({ "cec-ctl": { code: 127, stderr: "cec-ctl: command not found" } });
    const cec = createLinuxCecTransport({ run });

    expect(await cec.available()).toBe(false);
    // Not a failure to retry: no binary, no adapter and no permission all mean
    // there is no CEC here, which is what withdraws the capability for good.
    await expect(cec.scan()).rejects.toSatisfy(isTvUnsupported);
  });

  it("claims a logical address once, before the first transmit", async () => {
    // A fresh /dev/cec0 has no logical address and every --to transmit fails
    // with "Device has no logical address". This is the step that is easy to
    // forget and impossible to diagnose from the error.
    const run = fakeRunner({ "--give-device-power-status": { stdout: POWER_ON } });
    const cec = createLinuxCecTransport({ run });

    await cec.powerStatus(8);
    await cec.powerStatus(8);

    expect(run.calls[0]).toBe("cec-ctl -d /dev/cec0 --playback");
    expect(run.calls.filter((c) => c.endsWith("--playback"))).toHaveLength(1);
  });

  it("leaves the adapter alone when something else owns it", async () => {
    const run = fakeRunner({ "--give-device-power-status": { stdout: POWER_ON } });
    const cec = createLinuxCecTransport({ run, configure: false });

    await cec.powerStatus(8);
    expect(run.calls.some((c) => c.endsWith("--playback"))).toBe(false);
  });

  it("wakes a device by broadcasting its physical address", async () => {
    const run = fakeRunner({});
    const cec = createLinuxCecTransport({ run });

    await cec.wake({ logical: 8, physical: "3.1.0.0" });
    expect(run.calls).toContain("cec-ctl -d /dev/cec0 --set-stream-path phys-addr=3.1.0.0");
  });

  it("refuses to wake a device with no physical address", async () => {
    const cec = createLinuxCecTransport({ run: fakeRunner({}) });
    await expect(cec.wake({ logical: 8 })).rejects.toSatisfy(isTvUnsupported);
  });

  it("addresses standby rather than broadcasting it", async () => {
    // A broadcast <Standby> puts every device in the room to sleep, which is a
    // spectacular way to answer "turn off the console".
    const run = fakeRunner({});
    const cec = createLinuxCecTransport({ run });

    await cec.standby(8);
    expect(run.calls).toContain("cec-ctl -d /dev/cec0 --to 8 --standby");
  });

  it("treats a NACK as a failure, not as a device that is switched off", async () => {
    // NACK means nothing answered at that address — the device is not there.
    // Reporting it as a successful transmit would leave the planner believing a
    // console it cannot reach is now awake.
    const run = fakeRunner({ "--standby": { stdout: "Transmit to Playback Device 2 (8): NACK\n" } });
    const cec = createLinuxCecTransport({ run });

    await expect(cec.standby(8)).rejects.toThrow(/no device answered/);
  });

  it("reads the room through the discovery source it exists for", async () => {
    const run = fakeRunner({ "--show-topology": { stdout: TOPOLOGY } });
    const source = createCecSource(createLinuxCecTransport({ run }));

    const observations = await source.discover();
    // The television is left to the platform source; the AVR and what is behind
    // it come through with the topology intact.
    expect(observations.map((o) => o.id)).toEqual(["cec-3-0-0-0", "cec-3-1-0-0"]);
    expect(observations[1]?.parentId).toBe("cec-3-0-0-0");
    expect(observations[0]?.name).toBe("Denon AVR");
  });

  it("talks to the adapter it was given", async () => {
    const run = fakeRunner({});
    const cec = createLinuxCecTransport({ run, device: "/dev/cec1", as: "tv" });
    await cec.standby(0);
    expect(run.calls[0]).toBe("cec-ctl -d /dev/cec1 --tv");
  });
});
