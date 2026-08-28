import type { Capability } from "../capabilities/types.js";
import type { Tool } from "../tools/registry.js";
import type { DeviceGraph } from "./graph.js";
import type { DiscoverySource } from "./types.js";

/**
 * A way of reaching devices that are not the television.
 *
 * HDMI-CEC is the first one; IR, Wake-on-LAN, Matter and Home Assistant are the
 * same shape. Each contributes in two stages, and the order is the whole reason
 * this type exists:
 *
 *  1. **Before the room is built** it offers discovery sources, because what it
 *     can see is part of what the room *is*.
 *  2. **After the room is built** it is handed the graph and asked what it can
 *     now do — because the answer depends on what was found, and on what the
 *     merge decided to call it. A console someone registered by hand is `ps5`;
 *     CEC knows it as `2.0.0.0`; capabilities have to be registered under the
 *     name the *goal* will use, and only the merged graph knows what that is.
 *
 * Both stages are optional. A transport that only discovers (mDNS) implements
 * `sources`; one that only acts on devices already known (an IR blaster with a
 * hand-configured profile) implements `attach`.
 *
 * Nothing here names a transport, and core never learns what a CEC bus is: a
 * host passes these in, which is also why the same object works in the dev
 * harness and on a television with no edit.
 */
export interface DeviceTransport {
  /** For logs and diagnostics — `cec`, `ir`, `matter`. */
  id: string;
  /** Discovery sources to run while the room is being assembled. */
  sources?: DiscoverySource[];
  /**
   * What this transport can do, given the room that was found.
   *
   * Returns capabilities *and* tools because they answer different questions: a
   * tool is what the model may ask for, a capability is what the planner may
   * reason about. A transport supplying only one of them is either invisible to
   * goal mode or produces plans nothing can execute.
   */
  attach?(devices: DeviceGraph): Promise<TransportAttachment> | TransportAttachment;
}

export interface TransportAttachment {
  capabilities?: Capability[];
  tools?: Tool[];
  /** One line for the boot log — "2 devices reachable: ps5, stb". */
  note?: string;
}

/**
 * Ask every transport what it can do here, and let the ones that cannot fail
 * quietly.
 *
 * A transport that throws is dropped with its id recorded, exactly as a failing
 * discovery source is: a CEC adapter that is not there must not stop a
 * television from booting, and it is the *normal* case on every platform whose
 * image we do not own.
 */
export async function attachTransports(
  devices: DeviceGraph,
  transports: DeviceTransport[],
): Promise<{ capabilities: Capability[]; tools: Tool[]; notes: string[]; failed: string[] }> {
  const capabilities: Capability[] = [];
  const tools: Tool[] = [];
  const notes: string[] = [];
  const failed: string[] = [];

  for (const transport of transports) {
    if (!transport.attach) continue;
    try {
      const attachment = await transport.attach(devices);
      capabilities.push(...(attachment.capabilities ?? []));
      tools.push(...(attachment.tools ?? []));
      if (attachment.note) notes.push(`${transport.id}: ${attachment.note}`);
    } catch (err) {
      failed.push(transport.id);
      notes.push(`${transport.id}: unavailable — ${(err as Error).message}`);
    }
  }
  return { capabilities, tools, notes, failed };
}

/** Every discovery source the given transports offer, flattened. */
export function transportSources(transports: DeviceTransport[]): DiscoverySource[] {
  return transports.flatMap((t) => t.sources ?? []);
}
