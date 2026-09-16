import { TvUnsupportedError } from "@hearthkit/platform-api";
import type { CecDevice, CecPowerStatus, CecTransport } from "@hearthkit/adapter-cec";
import { systemRunner, type Runner } from "./run.js";

/**
 * HDMI-CEC on Linux, through `cec-ctl` — the only implementation of
 * `CecTransport` that a person can verify without a signing agreement.
 *
 * The other two candidates are behind a wall: Android's `HdmiControlManager`
 * needs the `@SystemApi` `HDMI_CEC` permission, and Tizen and webOS expose no
 * CEC surface at all. A Raspberry Pi has `/dev/cec0` and `apt install v4l-utils`,
 * which makes this the transport that turns the CEC package from *designed* into
 * *tested against something that can say no*.
 *
 * ## Two operational facts that are not obvious
 *
 * **An adapter must claim a logical address before it can transmit.** A fresh
 * `/dev/cec0` has none, and every `--to` transmit fails with "Device has no
 * logical address". `cec-ctl --playback` claims one. So the first transmit
 * configures, once, and `configure: false` exists for a box where something else
 * already owns the adapter — reconfiguring an adapter another daemon is driving
 * is a good way to break both.
 *
 * **CEC is slow.** A topology scan walks up to 15 addresses with a real timeout
 * on each, and 5 seconds — fine for `pactl` — is not enough. The default runner
 * here waits 15.
 *
 * ## What has and has not been checked
 *
 * The parsers are pure and unit-tested against `cec-ctl`'s documented output
 * shape. **No `/dev/cec*` device has run this code.** The flag spellings come
 * from v4l-utils' documentation rather than from a terminal in this room, so the
 * first person with a Pi should run `node tools/verify-cec.mjs`, which exercises
 * every path against the real adapter and prints a transcript ready to paste
 * back in as a fixture. Until someone does, this file is a careful guess with
 * its uncertainty written down — which is the only kind this project ships.
 */

export interface LinuxCecOptions {
  /** The adapter node. `/dev/cec0` on a Pi with one HDMI output. */
  device?: string;
  /** Run a command. Substituted in tests; defaults to a 15 s system runner. */
  run?: Runner;
  /**
   * Which logical address to claim before transmitting.
   *
   * `playback` is right for a box plugged into a TV, which is what this adapter
   * runs on. A device that *is* the television would claim `tv`, and then most
   * of this transport is pointing the wrong way.
   */
  as?: "playback" | "tv" | "audio" | "record" | "tuner";
  /** Skip claiming an address — for a box where another daemon owns the adapter. */
  configure?: boolean;
}

/** Longer than `pactl` needs, because a CEC poll genuinely takes seconds. */
const CEC_TIMEOUT_MS = 15_000;

export function createLinuxCecTransport(opts: LinuxCecOptions = {}): CecTransport {
  const device = opts.device ?? "/dev/cec0";
  const run = opts.run ?? systemRunner(CEC_TIMEOUT_MS);
  const role = opts.as ?? "playback";
  let configured = opts.configure === false;

  const cec = async (args: string[]): Promise<string> => {
    const result = await run("cec-ctl", ["-d", device, ...args]);
    if (result.code !== 0) {
      // No binary, no adapter, no permission — all of them mean "there is no CEC
      // for us here", which is `unsupported` rather than a failure to retry.
      throw new TvUnsupportedError(
        `cec-ctl ${args.join(" ")} on ${device}: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    return result.stdout;
  };

  const ensureConfigured = async (): Promise<void> => {
    if (configured) return;
    await cec([`--${role}`]);
    configured = true;
  };

  /**
   * A transmit that reached the bus but was not acknowledged.
   *
   * This is the distinction the whole package turns on, at its lowest level: a
   * device that NACKs is a device that is not there, and a device that ACKs and
   * does nothing is the case no error will ever tell us about.
   */
  const transmit = async (args: string[]): Promise<string> => {
    await ensureConfigured();
    const out = await cec(args);
    if (isNotAcknowledged(out)) throw new Error(`no device answered: ${args.join(" ")}`);
    return out;
  };

  return {
    available: async () => {
      // Plain `cec-ctl -d <dev>` prints the driver info and exits without
      // touching the bus — the cheap, side-effect-free question this method is
      // supposed to ask.
      const result = await run("cec-ctl", ["-d", device]);
      return result.code === 0;
    },

    scan: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await ensureConfigured();
      return parseTopology(await cec(["--show-topology"]));
    },

    powerStatus: async (logical) => {
      const out = await transmit(["--to", String(logical), "--give-device-power-status"]);
      return parsePowerStatus(out);
    },

    wake: async (target) => {
      if (!target.physical) {
        throw new TvUnsupportedError("no physical address for that device, so <Set Stream Path> has no operand");
      }
      // `<Set Stream Path>` is a broadcast that names a physical address: the
      // device at that address becomes the active source and, per spec, powers
      // on if it was in standby. "Per spec" is doing a lot of work in that
      // sentence, which is exactly why the capability above verifies with a
      // power-status read instead of trusting this call.
      await transmit(["--set-stream-path", `phys-addr=${target.physical}`]);
    },

    standby: async (logical) => {
      // Addressed, never broadcast. A broadcast `<Standby>` puts every device in
      // the room to sleep, which is a spectacular way to answer "turn off the
      // console".
      await transmit(["--to", String(logical), "--standby"]);
    },

    selectSource: async (target) => {
      if (!target.physical) {
        throw new TvUnsupportedError("no physical address for that device, so <Set Stream Path> has no operand");
      }
      await transmit(["--set-stream-path", `phys-addr=${target.physical}`]);
    },
  };
}

/**
 * `cec-ctl --show-topology` → the devices on the bus.
 *
 * The output is one block per remote device:
 *
 * ```
 * 	System Information for device 0 (TV) from device 4 (Playback Device 1):
 * 		CEC Version                : 1.4
 * 		Physical Address           : 0.0.0.0
 * 		Primary Device Type        : TV
 * 		Vendor ID                  : 0x000c03 (HDMI)
 * 		OSD Name                   : 'TV'
 * 		Power Status               : On
 * ```
 *
 * A field a device declined to answer is simply absent from its block, and stays
 * absent here — `CecDevice` makes every field but the address optional for
 * exactly this reason.
 */
export function parseTopology(out: string): CecDevice[] {
  const devices: CecDevice[] = [];
  // Split on the block header, keeping the address it names.
  const blocks = out.split(/System Information for device\s+(\d+)/).slice(1);
  for (let i = 0; i < blocks.length; i += 2) {
    const logical = Number(blocks[i]);
    const body = blocks[i + 1] ?? "";
    if (!Number.isInteger(logical) || logical < 0 || logical > 15) continue;

    const device: CecDevice = { logical };
    const physical = /Physical Address\s*:\s*([0-9a-fA-F](?:\.[0-9a-fA-F]){3})/.exec(body)?.[1];
    if (physical) device.physical = physical;
    // The name is quoted, and a television with an empty OSD name is a
    // television with no name — not one called `''`.
    const osdName = /OSD Name\s*:\s*'([^']*)'/.exec(body)?.[1]?.trim();
    if (osdName) device.osdName = osdName;
    // `0x000c03 (HDMI)` — the decoded name where cec-ctl knows one, the hex
    // where it does not. Both are more use to a person than the raw 24 bits.
    const vendor = /Vendor ID\s*:\s*(0x[0-9a-fA-F]+)(?:\s*\(([^)]+)\))?/.exec(body);
    if (vendor) device.vendorId = vendor[2]?.trim() || vendor[1];

    devices.push(device);
  }
  return devices;
}

/**
 * Did the bus refuse to acknowledge that transmit?
 *
 * **This function is why the package needed real hardware.** It used to be
 * `/\bNACK\b/i` — a spelling taken from how the CEC specification talks, not
 * from what `cec-ctl` prints. A Raspberry Pi running v4l-utils 1.30.1 answers an
 * unanswered transmit like this:
 *
 * ```text
 * Transmit from Playback Device 1 to TV (4 to 0):
 * GIVE_DEVICE_POWER_STATUS (0x8f)
 * 	Sequence: 20 Tx Timestamp: 22142.328382s
 * 	Tx, Not Acknowledged (4), Max Retries
 * ```
 *
 * The word `NACK` never appears, and **`cec-ctl` exits 0** — so neither the
 * exit-code check above nor the old pattern fired, and a message that reached
 * nobody came back as a successful transmit. `wake()` would have resolved on a
 * bus with nothing on it.
 *
 * The verification loop still caught the end result — the power-status read-back
 * cannot confirm a device that is not there, so the step reported `unverified`
 * rather than `verified` — but `unverified` means "nothing here can confirm it"
 * and this is "nothing accepted it", which is
 * [a different one of the four answers](../../../docs/platform/capability-matrix.md).
 *
 * Recorded 2026-09-15 on a Pi Zero W, kernel 6.18.34, with no HDMI attached —
 * note that an empty bus was enough to find it. `Low Drive`, `Arbitration Lost`
 * and a bare `Error` are also transmit failures in `cec-ctl`'s vocabulary; they
 * are matched here on the same reasoning, and unlike the first two that is still
 * reasoning rather than a recording.
 */
export function isNotAcknowledged(out: string): boolean {
  return /\bNot Acknowledged\b/i.test(out)
    || /\bNACK\b/i.test(out)
    || /\bLow Drive\b/i.test(out)
    || /\bArbitration Lost\b/i.test(out);
}

/** `cec-ctl`'s spelling of the four `<Report Power Status>` operands. */
const POWER_STATES: Record<string, CecPowerStatus> = {
  "on": "on",
  "standby": "standby",
  "to-on": "to_on",
  "to-standby": "to_standby",
};

/**
 * `cec-ctl --give-device-power-status` → the reply, or `"unknown"`.
 *
 * The reply looks like:
 *
 * ```
 * CEC_MSG_REPORT_POWER_STATUS (0x90):
 * 	pwr-state: on (0x00)
 * ```
 *
 * Everything else — a timeout, a NACK, a device that acknowledged and never
 * replied — is `"unknown"`, and that is the answer that matters most: it is the
 * difference between "the console is asleep" and "the console didn't say", and
 * collapsing the two is how an agent ends up waking something that was already
 * on.
 */
export function parsePowerStatus(out: string): CecPowerStatus {
  const named = /pwr-state:\s*([a-z-]+)/i.exec(out)?.[1]?.toLowerCase();
  if (named && POWER_STATES[named]) return POWER_STATES[named];
  // Fall back to the raw operand, for a build of cec-ctl that prints the number
  // without a name.
  const raw = /pwr-state:.*?\(0x0([0-3])\)/i.exec(out)?.[1];
  if (raw) return (["on", "standby", "to_on", "to_standby"] as const)[Number(raw)] ?? "unknown";
  return "unknown";
}
