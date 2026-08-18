import type {
  Connection, DeviceNode, DeviceObservation, DeviceType, DiscoverySource,
} from "./types.js";

/**
 * The living room's topology.
 *
 * Structure only. Volatile per-device state — power, current app — belongs in
 * the World Model under `devices.<id>.*`, so a power poll every ten seconds does
 * not churn the topology, and a device can be "known to exist, current state
 * unknown", which is the normal case rather than an edge one.
 */
export class DeviceGraph {
  private nodes = new Map<string, DeviceNode>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Fold an observation in, merging with whatever we already believe.
   *
   * Identity is decided by the strongest key the observation carries: an
   * explicit id, then MAC, then CEC physical address, then the HDMI port, then a
   * normalised name. Anything weaker would merge two identical soundbars;
   * anything stronger would leave the same PS5 in the graph three times, once
   * per source that found it.
   */
  observe(obs: DeviceObservation): DeviceNode {
    const existing = this.match(obs);
    const id = existing?.id ?? obs.id ?? synthesizeId(obs);
    const merged: DeviceNode = {
      id,
      type: pick(obs.type, existing?.type, "unknown") as DeviceType,
      name: pick(obs.name, existing?.name, id) as string,
      connection: pick(obs.connection, existing?.connection, { kind: "unknown" } as Connection) as Connection,
      capabilities: [...new Set([...(existing?.capabilities ?? []), ...(obs.capabilities ?? [])])],
      discoveredBy: [...new Set([...(existing?.discoveredBy ?? []), obs.source])],
      // Max, not newest: CEC knowing the name does not make mDNS wrong about the
      // IP, and taking the newer observation wholesale would keep discarding one
      // source's good field for another's blank.
      confidence: Math.max(existing?.confidence ?? 0, obs.confidence ?? 0.5),
      lastSeen: this.now(),
      ...(obs.vendor ?? existing?.vendor ? { vendor: (obs.vendor ?? existing?.vendor)! } : {}),
      ...(obs.model ?? existing?.model ? { model: (obs.model ?? existing?.model)! } : {}),
      ...(obs.parentId ?? existing?.parentId ? { parentId: (obs.parentId ?? existing?.parentId)! } : {}),
    };
    this.nodes.set(id, merged);
    return merged;
  }

  get(id: string): DeviceNode | undefined {
    return this.nodes.get(id);
  }

  list(filter: { type?: DeviceType; parentId?: string } = {}): DeviceNode[] {
    return [...this.nodes.values()].filter((d) =>
      (filter.type === undefined || d.type === filter.type)
      && (filter.parentId === undefined || d.parentId === filter.parentId));
  }

  /** Resolve a spoken name — "the PlayStation" — to a device. Best match first. */
  find(query: string): DeviceNode[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.list()
      .filter((d) => d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Which TV input shows this device — following parents, because an Apple TV
   * behind an AVR is reached through the AVR's HDMI port, and that hop is
   * exactly the thing that would otherwise be hard-coded.
   */
  inputPortFor(id: string): string | undefined {
    let node = this.nodes.get(id);
    const seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      if (node.connection.kind === "hdmi") return node.connection.port;
      node = node.parentId ? this.nodes.get(node.parentId) : undefined;
    }
    return undefined;
  }

  /** Devices in tree order, for `?diag` and the UI. */
  tree(): { node: DeviceNode; depth: number }[] {
    const out: { node: DeviceNode; depth: number }[] = [];
    const walk = (parentId: string | undefined, depth: number): void => {
      for (const node of this.list({ ...(parentId !== undefined ? { parentId } : {}) })) {
        if (parentId === undefined && node.parentId !== undefined) continue;
        out.push({ node, depth });
        walk(node.id, depth + 1);
      }
    };
    walk(undefined, 0);
    return out;
  }

  dump(): DeviceNode[] {
    return [...this.nodes.values()];
  }

  restore(nodes: DeviceNode[]): void {
    for (const node of nodes) this.nodes.set(node.id, node);
  }

  private match(obs: DeviceObservation): DeviceNode | undefined {
    if (obs.id && this.nodes.has(obs.id)) return this.nodes.get(obs.id);
    const all = [...this.nodes.values()];
    if (obs.mac) {
      const hit = all.find((d) => d.connection.kind === "network" && d.connection.mac === obs.mac);
      if (hit) return hit;
    }
    if (obs.connection?.kind === "hdmi") {
      const port = obs.connection.port;
      const hit = all.find((d) => d.connection.kind === "hdmi" && d.connection.port === port);
      if (hit) return hit;
    }
    if (obs.name) {
      const norm = normalize(obs.name);
      const hit = all.find((d) => normalize(d.name) === norm);
      if (hit) return hit;
    }
    return undefined;
  }
}

/**
 * Run every available source and fold the results in.
 *
 * One unavailable or failing source must never stop discovery: a room where
 * mDNS times out should still know about the PS5 that CEC found.
 */
export async function runDiscovery(
  graph: DeviceGraph,
  sources: DiscoverySource[],
  signal?: AbortSignal,
): Promise<{ found: number; failed: DiscoverySource["id"][] }> {
  const failed: DiscoverySource["id"][] = [];
  let found = 0;
  const batches = await Promise.all(sources.map(async (source) => {
    try {
      if (!(await source.available())) return [];
      return await source.discover(signal);
    } catch {
      failed.push(source.id);
      return [];
    }
  }));
  for (const batch of batches) {
    for (const obs of batch) {
      graph.observe(obs);
      found++;
    }
  }
  return { found, failed };
}

/** A source backed by whatever the user or an OEM told us. Highest confidence. */
export function createManualSource(devices: DeviceObservation[]): DiscoverySource {
  return {
    id: "manual",
    available: async () => devices.length > 0,
    discover: async () => devices.map((d) => ({ confidence: 1, ...d, source: "manual" as const })),
  };
}

function synthesizeId(obs: DeviceObservation): string {
  if (obs.name) return normalize(obs.name).replace(/\s+/g, "-");
  if (obs.connection?.kind === "hdmi") return obs.connection.port;
  if (obs.mac) return `dev-${obs.mac.replace(/[^a-z0-9]/gi, "")}`;
  return `dev-${obs.source}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function pick<T>(...candidates: (T | undefined)[]): T | undefined {
  return candidates.find((c) => c !== undefined);
}
