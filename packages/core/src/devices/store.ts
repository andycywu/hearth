import type { KeyValueStore } from "@tv-ai-agent/platform-api";
import { DeviceGraph } from "./graph.js";
import type { DeviceNode, DeviceObservation, DiscoverySource } from "./types.js";

/**
 * The room, remembered across reboots.
 *
 * Discovery is expensive, intermittent and often unavailable — CEC needs the
 * console awake, mDNS needs the network up, and a TV that has just been switched
 * on has neither. A room that has to be rediscovered from nothing every boot is
 * a room the agent does not know at the exact moment someone is most likely to
 * ask it for something.
 *
 * What is stored is *structure*, not state: which devices exist and where they
 * are plugged in. Whether the PS5 is on right now belongs to the World Model,
 * which is deliberately not persisted — a power state from last Tuesday is worse
 * than not knowing.
 *
 * Same trust boundary as installed skills: something has to write here
 * deliberately. The runtime never fetches a device list from anywhere.
 */

const KEY = "devices:graph";
/** Enough for a living room, small enough not to abuse device storage. */
export const MAX_DEVICES = 64;

export async function saveDevices(
  storage: KeyValueStore,
  graph: DeviceGraph,
  key = KEY,
): Promise<void> {
  const nodes = graph.dump().slice(0, MAX_DEVICES);
  await storage.set(key, JSON.stringify(nodes));
}

/**
 * Restore what was saved. A malformed entry is skipped rather than thrown:
 * one bad record must not stop the agent from starting.
 */
export async function loadDevices(
  storage: KeyValueStore,
  graph = new DeviceGraph(),
  key = KEY,
): Promise<DeviceGraph> {
  const raw = await storage.get(key);
  if (!raw) return graph;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return graph;
  }
  if (!Array.isArray(parsed)) return graph;
  graph.restore(parsed.filter(isDeviceNode).slice(0, MAX_DEVICES));
  return graph;
}

/**
 * Register a device by hand — the OEM provisioning step, or a user telling the
 * agent where the console is. Highest confidence there is: nothing discovered
 * beats being told.
 */
export async function registerDevice(
  storage: KeyValueStore,
  observation: DeviceObservation,
  key = KEY,
): Promise<DeviceNode> {
  const graph = await loadDevices(storage, new DeviceGraph(), key);
  const node = graph.observe({ confidence: 1, ...observation, source: "manual" });
  await saveDevices(storage, graph, key);
  return node;
}

/** Forget one. Returns whether it was there. */
export async function forgetDevice(
  storage: KeyValueStore,
  id: string,
  key = KEY,
): Promise<boolean> {
  const graph = await loadDevices(storage, new DeviceGraph(), key);
  const remaining = graph.dump().filter((d) => d.id !== id);
  if (remaining.length === graph.dump().length) return false;
  const next = new DeviceGraph();
  next.restore(remaining);
  await saveDevices(storage, next, key);
  return true;
}

/** Everything already stored, as a discovery source. */
export function createStoredSource(storage: KeyValueStore, key = KEY): DiscoverySource {
  return {
    id: "manual",
    available: async () => (await storage.get(key)) !== null,
    discover: async () => {
      const graph = await loadDevices(storage, new DeviceGraph(), key);
      return graph.dump().map((node) => ({
        id: node.id,
        type: node.type,
        name: node.name,
        connection: node.connection,
        capabilities: node.capabilities,
        confidence: node.confidence,
        source: "manual" as const,
        ...(node.vendor ? { vendor: node.vendor } : {}),
        ...(node.model ? { model: node.model } : {}),
        ...(node.parentId ? { parentId: node.parentId } : {}),
      }));
    },
  };
}

function isDeviceNode(value: unknown): value is DeviceNode {
  const node = value as DeviceNode | null;
  return !!node
    && typeof node === "object"
    && typeof node.id === "string" && node.id.length > 0
    && typeof node.name === "string"
    && typeof node.connection === "object" && node.connection !== null
    && typeof (node.connection as { kind?: unknown }).kind === "string";
}
