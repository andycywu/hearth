import type { Connection, DeviceType } from "@hearthkit/core";
import type { CecDevice, CecLogicalAddress } from "./types.js";

/**
 * Turning what CEC says into what the Device Graph stores — and refusing to
 * turn it into more than that.
 *
 * Two pieces of a CEC device's identity are genuinely informative, and a third
 * is a trap:
 *
 *  - **The physical address** is topology, and it is exact. `2.0.0.0` is the
 *    device on the TV's HDMI2. `2.1.0.0` is a device on port 1 of *that* device,
 *    which is how an AVR with a console behind it announces itself. This is the
 *    parent-hop the Device Graph has had a field for since before anything could
 *    fill it in.
 *  - **The OSD name** is what the device calls itself, and it is usually the
 *    truth: "PlayStation 5", "Apple TV", "SHIELD".
 *  - **The logical address is the trap.** It is assigned by *function slot* —
 *    a console, a Blu-ray player and a streaming stick all take a Playback
 *    address, and which of 4, 8 or 11 they get depends on who plugged in first.
 *    It says "something that plays" and nothing more, and a mapping that turns
 *    address 4 into `game_console` would be inventing a device.
 *
 * So the type comes from the logical address only where the spec is unambiguous
 * (a TV is a TV, an audio system is an AVR), and otherwise from the name, and
 * otherwise stays `unknown`. `unknown` on a device we can see and control is a
 * perfectly good answer — the graph already renders it, and the agent can ask.
 */

/** Logical address classes, from the CEC spec's address allocation table. */
const RECORDING = [1, 2, 9];
const TUNER = [3, 6, 7, 10];
const PLAYBACK = [4, 8, 11];
const AUDIO_SYSTEM = 5;
const TV = 0;

/**
 * Name patterns worth trusting, and only these.
 *
 * A device that calls itself "PlayStation 5" is a PlayStation 5; there is no
 * scenario where that string is a soundbar. The list is short on purpose — it
 * grows when someone reports a name from a real living room, not when someone
 * imagines one.
 */
const NAME_HINTS: Array<[RegExp, DeviceType]> = [
  [/playstation|\bps[45]\b|xbox|nintendo|\bswitch\b|steam ?deck/i, "game_console"],
  [/apple ?tv|fire ?tv|chromecast|google ?tv|roku|shield|mi ?box/i, "streaming_stick"],
  [/soundbar|sound ?bar/i, "soundbar"],
  [/receiver|\bavr\b|denon|marantz|yamaha|onkyo/i, "avr"],
];

/**
 * What kind of device this is, from what CEC actually said.
 *
 * Name first where it is decisive, then the unambiguous logical classes, then
 * `unknown`. An audio system that calls itself a soundbar is a soundbar; an
 * audio system that says nothing is an AVR, because address 5 has exactly one
 * meaning.
 */
export function deviceTypeFor(device: CecDevice): DeviceType {
  const name = device.osdName ?? "";
  for (const [pattern, type] of NAME_HINTS) {
    if (pattern.test(name)) return type;
  }
  if (device.logical === TV) return "tv";
  if (device.logical === AUDIO_SYSTEM) return "avr";
  if (TUNER.includes(device.logical) || RECORDING.includes(device.logical)) return "stb";
  // Playback (4/8/11) deliberately falls through: it is the largest class and
  // the least specific, and every guess we could make here is a coin toss.
  if (PLAYBACK.includes(device.logical)) return "unknown";
  return "unknown";
}

/** `"2.1.0.0"` → `[2, 1, 0, 0]`. Returns undefined for anything malformed. */
export function parsePhysical(physical: string | undefined): number[] | undefined {
  if (!physical) return undefined;
  const parts = physical.split(".");
  if (parts.length !== 4) return undefined;
  const nibbles = parts.map((p) => Number(p));
  if (nibbles.some((n) => !Number.isInteger(n) || n < 0 || n > 15)) return undefined;
  return nibbles;
}

/**
 * Which of the TV's own HDMI ports this device is reachable through.
 *
 * The first nibble, and only the first: `2.1.0.0` is behind something else, but
 * it still arrives at the television on HDMI2, and that is the port the TV would
 * have to select. `0.0.0.0` is the TV itself, which is not on a port at all.
 */
export function connectionFor(device: CecDevice): Connection {
  const nibbles = parsePhysical(device.physical);
  const port = nibbles?.[0];
  if (port === undefined) return { kind: "unknown" };
  if (port === 0) return { kind: "internal" };
  if (port > 4) {
    // The graph's `Connection` covers hdmi1-4, which is every television anyone
    // here has seen. A fifth port is not impossible, and saying "unknown" is
    // better than claiming a port that does not exist in the type.
    return { kind: "unknown" };
  }
  return { kind: "hdmi", port: `hdmi${port}` as "hdmi1" };
}

/**
 * The physical address of whatever this device is plugged into, or undefined
 * when it hangs off the TV directly.
 *
 * `2.1.0.0` → `2.0.0.0`: clear the last non-zero nibble. That is the whole rule,
 * and it is why an AVR with a console behind it produces a two-level graph with
 * no extra discovery — the topology is already in the addresses.
 */
export function parentPhysical(physical: string | undefined): string | undefined {
  const nibbles = parsePhysical(physical);
  if (!nibbles) return undefined;
  let last = -1;
  for (let i = nibbles.length - 1; i >= 0; i--) {
    if (nibbles[i] !== 0) { last = i; break; }
  }
  if (last <= 0) return undefined; // 0.0.0.0 (the TV) or x.0.0.0 (on the TV)
  const parent = [...nibbles];
  parent[last] = 0;
  return parent.join(".");
}

/**
 * A stable id for a CEC device.
 *
 * The physical address, not the logical one: logical addresses are reallocated
 * when devices come and go, so a console that took address 4 today can be 8
 * tomorrow and would arrive as a second device. The physical address is where it
 * is *plugged in*, which only changes when someone moves a cable — and when they
 * do, it should be a different node.
 */
export function deviceIdFor(device: CecDevice): string {
  return device.physical ? `cec-${device.physical.replace(/\./g, "-")}` : `cec-l${device.logical}`;
}

/** A name to show when the device never sent one. */
export function fallbackName(device: CecDevice, type: DeviceType): string {
  const connection = connectionFor(device);
  const where = connection.kind === "hdmi" ? connection.port.toUpperCase() : `CEC ${device.logical}`;
  return type === "unknown" ? `Device on ${where}` : `${type.replace(/_/g, " ")} on ${where}`;
}

export function isBroadcast(logical: CecLogicalAddress): boolean {
  return logical === 15;
}
