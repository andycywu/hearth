import type { DeviceObservation, DiscoverySource } from "@hearthkit/core";
import { connectionFor, deviceIdFor, deviceTypeFor, fallbackName, parentPhysical } from "./addresses.js";
import type { CecDevice, CecTransport } from "./types.js";

/**
 * The first discovery source that can see something the TV cannot.
 *
 * Until now the Device Graph was filled by two sources: `manual` (someone told
 * us) and `platform` (the TV knows which input is selected, so *something* is on
 * HDMI2). CEC is the first one that can say **what** — by name, by vendor, and
 * with the topology behind it.
 *
 * ## Confidence, and why it is not 1
 *
 * A CEC device that answered a poll definitely exists, so the *existence* is
 * strong evidence — stronger than the platform's 0.4 shrug and weaker than a
 * human typing "PlayStation 5". But the fields differ in how much they are
 * worth, and the graph merges per field:
 *
 *  - existence and topology: 0.9. It answered from that address.
 *  - the type: as good as the evidence it came from. A device that named itself
 *    is trusted; a Playback address on its own is `unknown`, not a guess.
 *
 * The merge rule the Device Graph already enforces does the rest: better
 * evidence wins per field, and `unknown` never overwrites a known type. A
 * hand-registered PlayStation 5 keeps its name when CEC arrives and reports
 * `Device on HDMI2` — that exact regression is already pinned by a test in core.
 */
export function createCecSource(transport: CecTransport): DiscoverySource {
  return {
    id: "hdmi_cec",
    available: () => transport.available(),
    discover: async (signal?: AbortSignal) => {
      const devices = await transport.scan(signal);
      const byPhysical = new Map<string, CecDevice>();
      for (const device of devices) {
        if (device.physical) byPhysical.set(device.physical, device);
      }

      const observations: DeviceObservation[] = [];
      for (const device of devices) {
        // The TV announces itself on the bus at 0.0.0.0. It is already the root
        // of the graph, put there by the platform source with the model name the
        // HAL knows, so adding a second claim to it here would only ever make
        // that worse.
        if (device.logical === 0) continue;

        const type = deviceTypeFor(device);
        const parentAddress = parentPhysical(device.physical);
        const parent = parentAddress ? byPhysical.get(parentAddress) : undefined;

        observations.push({
          id: deviceIdFor(device),
          type,
          name: device.osdName?.trim() || fallbackName(device, type),
          connection: connectionFor(device),
          confidence: 0.9,
          source: "hdmi_cec",
          cecAddress: device.physical ?? String(device.logical),
          ...(device.vendorId ? { vendor: device.vendorId } : {}),
          // Only when the parent is on the bus too. A device reporting 2.1.0.0
          // with nothing at 2.0.0.0 is telling us there is a switch or an AVR in
          // the path that does not speak CEC — real, and not something to invent
          // a node for.
          ...(parent ? { parentId: deviceIdFor(parent) } : {}),
        });
      }
      return observations;
    },
  };
}
