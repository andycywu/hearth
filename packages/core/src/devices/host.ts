import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import { launchSearch } from "../launch-flags.js";
import { DeviceGraph, createManualSource, runDiscovery } from "./graph.js";
import { createPlatformSource } from "./platform-source.js";
import { createStoredSource, saveDevices } from "./store.js";
import type { DeviceObservation } from "./types.js";

/**
 * The room, assembled the way every host needs it — once, here.
 *
 * Each host was going to grow its own copy of "load what was stored, ask the
 * platform, persist the result", and the dev harness already had one. Four
 * slightly different versions of that is how a device ends up with a room the
 * emulator does not have, so it lives in one place with the flags spelled out.
 *
 * Order matters: stored first (someone told us, and that is the strongest
 * evidence), then the platform (which can only see that *something* is on the
 * current input). Weaker evidence may add fields and never overwrite better ones,
 * so the order is belt and braces rather than load-bearing.
 */

/** A living room to demonstrate the goal-based scenarios with. */
export const DEMO_ROOM: DeviceObservation[] = [
  {
    id: "ps5", type: "game_console", name: "PlayStation 5",
    connection: { kind: "hdmi", port: "hdmi2" }, source: "manual",
  },
  {
    id: "stb", type: "stb", name: "Set-top box",
    connection: { kind: "hdmi", port: "hdmi3" }, source: "manual",
  },
];

export interface RoomOptions {
  /**
   * `demo` seeds a console and a set-top box when storage is empty — a bring-up
   * aid, in the same family as `?confirm=auto`, because an emulator has no HDMI
   * devices and Scenario B is the one worth watching. `empty` skips storage
   * entirely, to see what the agent says when it knows where nothing is.
   */
  room?: "demo" | "empty" | "stored";
  /** Persist what was found. Off for `empty`. */
  persist?: boolean;
  search?: string;
}

/** `?room=demo|empty`. Anything else means "just use what is stored". */
export function roomOptionFromUrl(search = launchSearch()): RoomOptions["room"] {
  const value = new URLSearchParams(search).get("room");
  return value === "demo" || value === "empty" ? value : "stored";
}

export async function discoverRoom(
  platform: PlatformProvider,
  opts: RoomOptions = {},
): Promise<DeviceGraph> {
  const room = opts.room ?? roomOptionFromUrl(opts.search);
  const devices = new DeviceGraph();

  if (room === "empty") {
    await runDiscovery(devices, [createPlatformSource(platform)]);
    return devices;
  }

  const stored = createStoredSource(platform.storage);
  // The demo room is a fallback, not a default: once anything is stored, that is
  // the room, and a demo device reappearing beside a real one is a bug someone
  // would spend an afternoon on.
  const seed = room === "demo" && !(await stored.available()) ? DEMO_ROOM : [];
  const result = await runDiscovery(devices, [
    stored,
    createPlatformSource(platform),
    createManualSource(seed),
  ]);
  if (result.failed.length) {
    console.warn(`[devices] sources failed: ${result.failed.join(", ")}`);
  }
  if (opts.persist !== false) await saveDevices(platform.storage, devices);
  return devices;
}
