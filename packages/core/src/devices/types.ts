/**
 * What is in the room — as distinct from what can be done with it.
 *
 * The split from the Capability Graph is the load-bearing idea: a PS5 nobody can
 * control still exists, and knowing it exists changes the answer ("it's on
 * HDMI2, but I can't wake it from here"). Merging the two would make an
 * uncontrollable device invisible, which is the worst of both.
 *
 * See docs/device-graph.md.
 */

export type DeviceType =
  | "tv" | "game_console" | "streaming_stick" | "avr" | "stb" | "soundbar"
  | "speaker" | "light" | "thermostat" | "camera" | "phone" | "unknown";

export type Connection =
  | { kind: "hdmi"; port: "hdmi1" | "hdmi2" | "hdmi3" | "hdmi4" }
  | { kind: "network"; ip?: string; mac?: string; host?: string }
  | { kind: "bluetooth"; address: string }
  | { kind: "ir"; profile: string }
  /** The TV itself, and anything running inside it. */
  | { kind: "internal" }
  | { kind: "unknown" };

export type DiscoverySourceId =
  | "manual" | "platform" | "hdmi_cec" | "ir_profile" | "mdns" | "ssdp"
  | "bluetooth" | "adb" | "ip_scan" | "matter" | "home_assistant" | "vision";

export interface DeviceNode {
  id: string;
  type: DeviceType;
  name: string;
  vendor?: string;
  model?: string;
  connection: Connection;
  /** An Apple TV behind an AVR has `parentId: "avr"` — reaching it is two steps. */
  parentId?: string;
  /** Capability ids this device offers. The graph itself lives in capabilities/. */
  capabilities: string[];
  discoveredBy: DiscoverySourceId[];
  confidence: number;
  lastSeen: number;
  /**
   * The CEC physical address (`"3.1.0.0"`), when a source knew it.
   *
   * Stored rather than merely observed because it is the only identity key that
   * distinguishes two devices sharing one of the TV's HDMI ports — an AVR at
   * `3.0.0.0` and whatever is plugged into it at `3.1.0.0` are both "on HDMI3",
   * and without this they merge into one node.
   */
  cecAddress?: string;
}

/** What a discovery source contributes: a claim, never the truth. */
export interface DeviceObservation {
  id?: string;
  type?: DeviceType;
  name?: string;
  vendor?: string;
  model?: string;
  connection?: Connection;
  parentId?: string;
  capabilities?: string[];
  source: DiscoverySourceId;
  confidence?: number;
  /** Strong identity keys, used to merge observations from different sources. */
  mac?: string;
  cecAddress?: string;
}

export interface DiscoverySource {
  id: DiscoverySourceId;
  /** Can this source run on this device at all? Cheap; no side effects. */
  available(): Promise<boolean>;
  discover(signal?: AbortSignal): Promise<DeviceObservation[]>;
}
