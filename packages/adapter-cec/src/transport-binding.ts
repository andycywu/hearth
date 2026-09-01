import type { DeviceGraph, DeviceTransport, TransportAttachment } from "@hearthkit/core";
import { cecTargets, createCecCapabilities, createCecTools } from "./capabilities.js";
import { createCecSource } from "./source.js";
import type { CecTransport } from "./types.js";

/**
 * A CEC bus, packaged as the thing a host wires in.
 *
 * Before this, wiring CEC into a host meant six steps in the right order: build
 * a source, pass it to `discoverRoom`, scan the bus *again*, join what it found
 * to what the room decided to call things, build capabilities from that, build
 * tools from that, and hand both to the agent. The dev harness had all six
 * inline, which is precisely how the three app hosts came to have three
 * different boot sequences — the fix for which was `@hearthkit/host`.
 *
 * So it collapses to one object. A host that gets a CEC bus — an Android build
 * signed to reach `HdmiControlManager`, a Linux box with `/dev/cec0` — supplies
 * `createCecTransport(bus)` and changes nothing else.
 *
 * The scan happens twice on purpose, once for discovery and once to resolve
 * targets, and both are cheap on a bus that is there. Caching it would mean
 * holding a topology from before `discoverRoom` merged anything, which is
 * exactly the stale-id bug this arrangement exists to avoid.
 */
export function createCecTransport(bus: CecTransport): DeviceTransport {
  return {
    id: "cec",
    sources: [createCecSource(bus)],
    attach: async (devices: DeviceGraph): Promise<TransportAttachment> => {
      // No bus is the normal answer — on Android without the HDMI_CEC
      // permission, and always on Tizen and webOS. Nothing is registered, so
      // nothing is offered to a model, and the capability graph is not left
      // holding promises this device cannot keep.
      if (!(await bus.available())) return { note: "no bus on this platform" };

      const targets = cecTargets(devices, await bus.scan());
      if (!targets.length) {
        // A bus with nothing on it is a real and unremarkable state: an HDMI
        // port with nothing plugged into it, or devices that do not speak CEC.
        return { note: "bus present, no reachable devices" };
      }

      return {
        capabilities: targets.flatMap((t) => createCecCapabilities(t.deviceId)),
        tools: await createCecTools(bus, targets),
        note: `${targets.length} device(s) reachable: ${targets.map((t) => t.deviceId).join(", ")}`,
      };
    },
  };
}
