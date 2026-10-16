/**
 * What is in the room, and how far this box can reach into it.
 *
 * The same assembly `@hearthkit/host` does for a television — discover, then
 * ask each transport what it can do given what was found — minus the window.
 * Shared between the agent and `hearth report` so the two cannot disagree about
 * which devices exist, which was exactly the kind of drift the host package was
 * created to end.
 */
import {
  discoverRoom, attachTransports, transportSources, deviceTreeText,
  defineTool, type DeviceGraph, type DeviceTransport, type Capability, type Tool,
} from "@hearthkit/core";
import type { PlatformProvider } from "@hearthkit/platform-api";
import type { CliOptions } from "./args.js";

export interface AssembledRoom {
  devices: DeviceGraph;
  capabilities: Capability[];
  tools: Tool[];
  /** What each transport said about its reach, one line each — for the report's notes. */
  notes: string[];
  /** The room as a tree, one line each — for the startup log. */
  tree: string[];
}

export interface RoomDeps {
  /** Persist discovery results to the platform's store. Off for a report. */
  persist?: boolean;
  /** Substituted in tests; defaults to the real CEC adapter on linux. */
  transports?: (opts: CliOptions) => Promise<DeviceTransport[]>;
  /** Substituted in tests; the real one reads /sys, /proc and `vcgencmd`. */
  hostStatus?: Tool[];
}

/**
 * "Is the Pi okay?" — a read-only tool for questions about *this box*, as opposed to the television.
 *
 * Not a capability: nothing here is something the room can be asked to become, so there is no goal to plan and no
 * read-back to do. It is for the model to answer with, through the same tool loop as `get_volume` — and its fields
 * that could not be read come back `null` and named, so the model has nothing to invent a number from.
 */
export async function hostStatusTool(read?: () => Promise<unknown>): Promise<Tool> {
  const readStatus = read ?? (async () => (await import("@hearthkit/adapter-linux")).readHostStatus());
  return defineTool(
    {
      name: "get_host_status",
      description:
        "Read the health of the computer Hearth runs on (the Raspberry Pi, not the television): CPU temperature in °C, free and total memory in MB, " +
        "1-minute load, uptime in seconds, and whether its power supply is under-voltage or throttled right now or has been since boot. " +
        "Read-only. A field that could not be measured is null and listed in `unreadable`; never guess it.",
      parameters: {},
    },
    async () => readStatus(),
  );
}

export async function assembleRoom(
  opts: CliOptions,
  platform: PlatformProvider,
  deps: RoomDeps = {},
): Promise<AssembledRoom> {
  const transports = await (deps.transports ?? defaultTransports)(opts);
  const devices = await discoverRoom(platform, {
    room: opts.room,
    persist: deps.persist ?? true,
    ...(transports.length ? { sources: transportSources(transports) } : {}),
  });
  const reach = await attachTransports(devices, transports);
  const tools = [...reach.tools, ...(deps.hostStatus ?? (opts.platform === "linux" ? [await hostStatusTool()] : []))];

  const notes = [
    ...reach.notes,
    ...reach.failed.map((id) => `${id}: transport failed and was dropped`),
  ];
  const tree = deviceTreeText(devices).split("\n").map((line) => `room: ${line}`);
  return { devices, capabilities: reach.capabilities, tools, notes, tree };
}

/**
 * HDMI-CEC through `cec-ctl`, on linux, unless told not to.
 *
 * The transport is built unconditionally and asked `available()` later by
 * `attachTransports`: no `/dev/cec0` is the normal answer on most machines, and
 * it costs one failed `cec-ctl` call to find out. The mock platform gets no
 * transports — it has nothing to be beside.
 */
async function defaultTransports(opts: CliOptions): Promise<DeviceTransport[]> {
  if (opts.platform !== "linux" || opts.cec === false) return [];
  const [{ createLinuxCecTransport }, { createCecTransport }] = await Promise.all([
    import("@hearthkit/adapter-linux"),
    import("@hearthkit/adapter-cec"),
  ]);
  // `remoteTv`: this box is a playback device on one of the TV's HDMI ports, not the TV, so the TV at CEC
  // address 0 is a device to drive — and its power is what "turn off the tv" means.
  return [createCecTransport(createLinuxCecTransport({ device: opts.cec }), { remoteTv: true })];
}
