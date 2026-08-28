import { TvUnsupportedError } from "@hearthkit/platform-api";
import type { CecDevice, CecLogicalAddress, CecPowerStatus, CecTransport } from "./types.js";

/**
 * A CEC bus with no HDMI cable in it.
 *
 * The point of this file is not to prove the happy path works. It is to make the
 * three ways a real CEC device disappoints you reproducible on a laptop, because
 * every one of them is a *different answer the agent must give*, and all three
 * look identical to code that assumes a command that was accepted was performed:
 *
 *  - **`answersPowerStatus: false`** — the device works, wakes, does everything
 *    asked of it, and never replies to `<Give Device Power Status>`. Extremely
 *    common. The honest answer is `unverified`, and an agent that says "done" here
 *    is guessing.
 *  - **`wakesOnStreamPath: false`** — the bus accepts `<Set Stream Path>`, the
 *    call resolves, and the device stays in standby. This is the failure this
 *    whole project is built around, in its purest form: *accepted and not
 *    performed*. The honest answer is `failed`.
 *  - **an absent bus** — `available()` is false and every call throws
 *    `TvUnsupportedError`. This is the *normal* case on Android and the only
 *    case on Tizen and webOS. The honest answer is `unsupported`, once, followed
 *    by never offering it again.
 *
 * A mock that only did the first of those would be a mock that agrees with us.
 */

export interface MockCecDevice extends CecDevice {
  power?: CecPowerStatus;
  /** Replies to `<Give Device Power Status>`. Real devices often do not. */
  answersPowerStatus?: boolean;
  /** Actually wakes when told to. Real devices sometimes do not. */
  wakesOnStreamPath?: boolean;
  /** Obeys `<Standby>`. */
  obeysStandby?: boolean;
}

export interface MockCecBusOptions {
  /** No CEC on this platform at all — the majority case. */
  absent?: boolean;
  /** Devices answer the poll but nothing else, as a bus with a bad adapter does. */
  scanFails?: boolean;
  /** Records every message the bus was asked to send, in order. */
  log?: string[];
}

export interface MockCecBus extends CecTransport {
  /** The bus's own view of the room, for a test to assert against. */
  devices: MockCecDevice[];
  /** Messages sent, as `"wake 2.0.0.0"` / `"standby 4"` / `"power_status 4"`. */
  sent: string[];
}

const DEFAULTS = {
  power: "standby" as CecPowerStatus,
  answersPowerStatus: true,
  wakesOnStreamPath: true,
  obeysStandby: true,
};

export function createMockCecBus(
  devices: MockCecDevice[] = [],
  opts: MockCecBusOptions = {},
): MockCecBus {
  const state = devices.map((d) => ({ ...DEFAULTS, ...d }));
  const sent = opts.log ?? [];

  const find = (logical: CecLogicalAddress): (typeof state)[number] | undefined =>
    state.find((d) => d.logical === logical);

  const requireBus = (): void => {
    if (opts.absent) {
      throw new TvUnsupportedError("no HDMI-CEC on this platform (needs the HDMI_CEC permission on Android)");
    }
  };

  return {
    devices: state,
    sent,

    available: async () => !opts.absent,

    scan: async (signal?: AbortSignal) => {
      requireBus();
      signal?.throwIfAborted();
      sent.push("scan");
      if (opts.scanFails) throw new Error("cec: bus read timed out");
      return state.map(({ logical, physical, osdName, vendorId }) => ({
        logical,
        ...(physical ? { physical } : {}),
        ...(osdName ? { osdName } : {}),
        ...(vendorId ? { vendorId } : {}),
      }));
    },

    powerStatus: async (logical) => {
      requireBus();
      sent.push(`power_status ${logical}`);
      const device = find(logical);
      // Not on the bus and not answering are the same thing from here: silence.
      if (!device || !device.answersPowerStatus) return "unknown";
      return device.power;
    },

    wake: async (device) => {
      requireBus();
      sent.push(`wake ${device.physical ?? device.logical}`);
      const target = find(device.logical);
      if (!target) return; // broadcast into an empty room: accepted, no effect
      if (target.wakesOnStreamPath) target.power = "on";
    },

    standby: async (logical) => {
      requireBus();
      sent.push(`standby ${logical}`);
      const target = find(logical);
      if (target?.obeysStandby) target.power = "standby";
    },

    selectSource: async (device) => {
      requireBus();
      sent.push(`set_stream_path ${device.physical ?? device.logical}`);
    },
  };
}

/**
 * The room the P0 scenarios describe, as CEC would report it.
 *
 * A console on HDMI2 that behaves, an AVR on HDMI3, and a streaming stick behind
 * that AVR — which is the two-level topology `parentId` has had a field for since
 * before anything could produce one.
 */
export const MOCK_LIVING_ROOM: MockCecDevice[] = [
  { logical: 0, physical: "0.0.0.0", osdName: "TV", power: "on" },
  { logical: 4, physical: "2.0.0.0", osdName: "PlayStation 5", vendorId: "Sony", power: "standby" },
  { logical: 5, physical: "3.0.0.0", osdName: "Denon AVR", power: "on" },
  { logical: 8, physical: "3.1.0.0", osdName: "Apple TV", power: "standby" },
];
