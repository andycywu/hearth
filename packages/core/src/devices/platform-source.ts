import type { PlatformProvider } from "@hearthkit/platform-api";
import type { DeviceObservation, DiscoverySource } from "./types.js";

/**
 * What the TV itself can tell us about the room, which is less than you would
 * hope and more than nothing.
 *
 * The HAL knows the TV's own identity, and it knows which input is *currently*
 * selected. It does not enumerate ports and it cannot see what is plugged into
 * them — that needs CEC (P1) or someone telling us. So this source reports two
 * things and does not embroider:
 *
 *  - the TV, as the root of the graph and the thing every capability hangs off;
 *  - the active input as an *occupied port*, when it is an HDMI one.
 *
 * The second is deliberately weak evidence (0.4) and deliberately typed
 * `unknown`: "something is on HDMI2, because the TV is showing it" is a real
 * fact and it is not the same as knowing it is a PS5. Naming it would be
 * inventing a device; leaving the port out would throw away the one hint the
 * platform actually gives us, and it is enough for the agent to ask "what's on
 * HDMI2?" instead of pretending the port is empty.
 */
export function createPlatformSource(platform: PlatformProvider): DiscoverySource {
  return {
    id: "platform",
    available: async () => true,
    discover: async () => {
      const device = platform.device;
      const observations: DeviceObservation[] = [{
        id: "tv",
        type: "tv",
        name: device.model || "TV",
        connection: { kind: "internal" },
        confidence: 1,
        source: "platform",
        ...(device.soc && device.soc !== "unknown" ? { vendor: device.soc } : {}),
        ...(device.model ? { model: device.model } : {}),
      }];

      try {
        const input = await platform.system.getInputSource();
        if (/^hdmi[1-4]$/.test(input)) {
          observations.push({
            type: "unknown",
            name: `Device on ${input.toUpperCase()}`,
            connection: { kind: "hdmi", port: input as "hdmi1" },
            confidence: 0.4,
            source: "platform",
          });
        }
      } catch {
        // A TV that cannot report its input tells us nothing about the room,
        // which is a smaller answer, not a failure.
      }
      return observations;
    },
  };
}
