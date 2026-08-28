import {
  W, createDevicePowerCapabilities, toolsFromCapabilities,
  type Capability, type CapabilityHandler, type DeviceGraph, type Tool,
} from "@hearthkit/core";
import { TvUnsupportedError } from "@hearthkit/platform-api";
import type { CecDevice, CecTransport } from "./types.js";

/**
 * What CEC adds to the Capability Graph, and the one thing it changes.
 *
 * `createDevicePowerCapabilities` in core already declares `ps5.power.on` and
 * `ps5.power.off` for any transport. Building this found that those two could
 * **never report `verified`**, by construction, and not because of CEC:
 *
 *   Their verification is `{ kind: "state", predicate: devices.ps5.power = on }`,
 *   and the executor deliberately refuses to let a step's own optimistic write
 *   verify it — `backing === "assumed"` returns `unverified`. So a `state`
 *   verification is only ever satisfied by *another* source writing that path: a
 *   perception event, a different tool, a person saying so. For device power
 *   there was no such source, so the honest-but-permanent answer was
 *   `unverified`.
 *
 * CEC is the first transport that can answer the question it was asked, because
 * `<Give Device Power Status>` exists. So this package adds a **read**
 * capability, `<device>.power.status`, and re-points the two writes at it as a
 * `read_back` — the same shape `tv.audio.set_volume` has always used. Nothing in
 * core changed; the capability that needed a reader now has one.
 *
 * The result is the distinction this project exists for, on real hardware:
 *
 *  - the console woke and says `on` → **verified**
 *  - the console does not answer `<Give Device Power Status>` → **unverified**,
 *    and the report says why
 *  - the bus accepted `<Set Stream Path>` and the console is still in standby →
 *    **failed**, which is a real thing CEC devices do
 *  - there is no CEC on this platform → **unsupported**, withdrawn, never
 *    offered to a model again
 */

export interface CecCapabilityOptions {
  /** The Device Graph node id this capability acts on — `cec-2-0-0-0`, `ps5`. */
  deviceId: string;
  /** The CEC device it resolves to. Needs `physical` for `<Set Stream Path>`. */
  device: CecDevice;
}

/**
 * Power on/off plus the status read that makes them verifiable.
 *
 * The two writes come from core's factory so the vocabulary, risk levels and
 * side effects stay in one place — this only replaces the verification, which is
 * the part that depends on whether a reader exists.
 */
export function createCecCapabilities(deviceId: string): Capability[] {
  const statusId = `${deviceId}.power.status`;
  const powerPath = W.device(deviceId, "power");
  const suffix = toolSuffix(deviceId);

  const status: Capability = {
    id: statusId,
    name: `Power state of ${deviceId}`,
    description: `Ask ${deviceId} over HDMI-CEC whether it is on or in standby.`,
    device: deviceId,
    domain: "power",
    parameters: {},
    tool: `cec_power_status_${suffix}`,
    // This map is what turns the answer into a fact the world can be verified
    // against — and it is why the reply must be the device's, never our own
    // assumption echoed back.
    reads: { power: powerPath },
    // A read that fails proves the transport is missing, which is exactly as
    // true of the writes beside it.
    vouchesFor: [`${deviceId}.power.on`, `${deviceId}.power.off`],
    riskLevel: "low",
    verification: { kind: "none", because: "reading a power state changes nothing" },
    provider: "cec",
    confidence: 0.9,
    status: "available",
  };

  const writes = createDevicePowerCapabilities(deviceId, "cec").map((capability) => ({
    ...capability,
    // Core names the tool after the *provider* — `cec_power_on` — which is fine
    // for one console and a boot crash for two: the registry throws on a
    // duplicate name, and a living room with a PS5 and a set-top box is the
    // normal case rather than an exotic one. Found by being the first caller to
    // register this factory for more than one device. Renamed here rather than
    // in core, because a connector that needs a core edit is the thing this
    // boundary exists to detect, and a tool name is not that.
    tool: `${capability.tool}_${suffix}`,
    verification: {
      kind: "read_back" as const,
      capability: statusId,
      predicate: {
        path: powerPath,
        equals: capability.id.endsWith(".on") ? "on" : "standby",
      },
    },
  }));

  return [status, ...writes];
}

/**
 * A device id as it can appear in a tool name.
 *
 * Tool names reach a model and are matched by it verbatim, so `cec-2-0-0-0`
 * becomes `cec_2_0_0_0`. Nothing is dropped — two devices must not collapse onto
 * one name here any more than they may in the registry.
 */
export function toolSuffix(deviceId: string): string {
  return deviceId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

/**
 * Capability id → the CEC call that performs it.
 *
 * `wake` resolving means the bus took the message. That is not the same as the
 * console waking, and the handler does not pretend otherwise: it returns nothing
 * to read, and the read-back is what settles it a moment later.
 */
export function cecHandlers(
  transport: CecTransport,
  targets: CecCapabilityOptions[],
): Record<string, CapabilityHandler> {
  const handlers: Record<string, CapabilityHandler> = {};
  for (const { deviceId, device } of targets) {
    handlers[`${deviceId}.power.status`] = async () => {
      const state = await transport.powerStatus(device.logical);
      // A device that did not answer must not produce a fact. Returning
      // `{ power: "unknown" }` would write "unknown" into the world through the
      // `reads` map and read back as a *failed* verification — the difference
      // between "it didn't say" and "it said no".
      if (state === "unknown") return {};
      // In-transition is a real answer and a temporary one. Reporting the state
      // it is heading for would be the same optimism the read exists to avoid,
      // so it is reported as neither on nor standby and the read-back stays
      // unsatisfied until the device settles.
      if (state === "to_on" || state === "to_standby") return { transitioning: state };
      return { power: state };
    };

    handlers[`${deviceId}.power.on`] = async () => {
      if (!device.physical) {
        // `<Set Stream Path>` is addressed by physical address. Without one
        // there is no message to send — that is absence, not failure.
        throw new TvUnsupportedError(
          `${deviceId} never reported a CEC physical address, so it cannot be woken over CEC`,
        );
      }
      await transport.wake(device);
      return {};
    };

    handlers[`${deviceId}.power.off`] = async () => {
      await transport.standby(device.logical);
      return {};
    };
  }
  return handlers;
}

/**
 * Match what CEC found against what the room already believes.
 *
 * The two are not the same list, and the difference is the useful part. A
 * console someone registered by hand is `ps5` in the Device Graph; CEC knows it
 * as `2.0.0.0`. The graph merges them into one node — by HDMI port, or by CEC
 * address once one is known — and **the node's id is the one that matters**,
 * because that is what a skill resolves to when someone says 「我要打 PS5」.
 * Registering capabilities under `cec-2-0-0-0` instead would produce a plan for
 * a device the goal has never heard of.
 *
 * Devices CEC saw but the graph does not hold, and nodes with no CEC address,
 * are both simply absent from the result: one is a device we cannot name, the
 * other a device we cannot reach.
 */
export function cecTargets(graph: DeviceGraph, found: CecDevice[]): CecCapabilityOptions[] {
  const byPhysical = new Map<string, CecDevice>();
  for (const device of found) {
    if (device.physical) byPhysical.set(device.physical, device);
  }
  const targets: CecCapabilityOptions[] = [];
  for (const node of graph.list()) {
    const address = node.cecAddress;
    if (!address) continue;
    const device = byPhysical.get(address);
    // The television answers on the bus at 0.0.0.0 and is not something to
    // power on over CEC from itself.
    if (!device || device.logical === 0) continue;
    targets.push({ deviceId: node.id, device });
  }
  return targets;
}

/**
 * The tools for a set of CEC-reachable devices.
 *
 * Returns an empty list when the transport is unavailable, which is the common
 * case and not an error: a capability with no handler is simply not projected,
 * so the graph still knows `ps5.power.on` is a thing that exists in the world
 * while the model is never offered a button that cannot work.
 */
export async function createCecTools(
  transport: CecTransport,
  targets: CecCapabilityOptions[],
): Promise<Tool[]> {
  if (!(await transport.available())) return [];
  const capabilities = targets.flatMap((t) => createCecCapabilities(t.deviceId));
  return toolsFromCapabilities(capabilities, cecHandlers(transport, targets));
}
