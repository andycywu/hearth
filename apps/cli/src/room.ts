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
  type DeviceGraph, type DeviceTransport, type Capability, type Tool,
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

  const notes = [
    ...reach.notes,
    ...reach.failed.map((id) => `${id}: transport failed and was dropped`),
  ];
  const tree = deviceTreeText(devices).split("\n").map((line) => `room: ${line}`);
  return { devices, capabilities: reach.capabilities, tools: reach.tools, notes, tree };
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
  return [createCecTransport(createLinuxCecTransport({ device: opts.cec }))];
}
