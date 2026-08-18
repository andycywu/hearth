# Device Graph

> The Device Graph answers **"what exists?"**.
> The Capability Graph answers **"what can I do with it?"**.
> They are deliberately separate: a PS5 you cannot control still exists, and
> knowing it exists changes the plan.

Implementation: [`packages/core/src/devices/`](../packages/core/src/devices/).

## The gap it closes

`platform-api` models an input as a closed string union — `hdmi1`..`hdmi4`, `tv`,
`av`. That is a *port*, not a thing. "我要打 PS5" cannot be answered by a port
enum; it needs to know that the console named PS5 is attached to HDMI2, is
currently in standby, and can be woken over CEC.

## The model

```ts
interface DeviceNode {
  id: string;                  // "ps5" — stable, human-meaningful where possible
  type: DeviceType;            // tv | game_console | streaming_stick | avr | stb |
                               // soundbar | speaker | light | thermostat | camera | phone | unknown
  name: string;                // "PlayStation 5"
  vendor?: string;
  model?: string;
  connection: Connection;      // how we reach it
  power?: "on" | "standby" | "off" | "unknown";
  parentId?: string;           // an Apple TV behind an AVR has parentId "avr"
  capabilities: string[];      // Capability ids this device offers
  discoveredBy: DiscoverySourceId[];
  confidence: number;          // 0..1
  lastSeen: number;
}

type Connection =
  | { kind: "hdmi"; port: "hdmi1" | "hdmi2" | "hdmi3" | "hdmi4" }
  | { kind: "network"; ip?: string; mac?: string; host?: string }
  | { kind: "bluetooth"; address: string }
  | { kind: "ir"; profile: string }
  | { kind: "internal" }       // the TV itself, its apps
  | { kind: "unknown" };
```

The graph is a forest rooted at the room:

```
Living Room
|- TV (internal)
|- HDMI1 -> AVR
|            `- Apple TV
|- HDMI2 -> PS5
|- HDMI3 -> STB
`- IoT
    |- light.ceiling
    `- ac.living_room
```

The AVR case is why `parentId` exists: switching to "Apple TV" means switching
the TV to HDMI1 *and* selecting the AVR's input. Without the parent edge that is
a hard-coded special case; with it, it is a plan.

## Discovery sources

Every source implements one interface and contributes *observations*, never
authoritative truth:

```ts
interface DiscoverySource {
  id: DiscoverySourceId;
  available(): Promise<boolean>;
  discover(signal?: AbortSignal): Promise<DeviceObservation[]>;
}
```

| Source | Yields | Confidence | Phase |
|---|---|---|---|
| `manual` | user-registered devices | 1.0 | P0 |
| `platform` | the TV itself and its input ports, from the HAL | 1.0 | P0 |
| `hdmi_cec` | vendor/OSD name, physical address, power state | 0.9 | P1 |
| `ir_profile` | devices we can only address blindly | 0.5 | P1 |
| `mdns` | Apple TV, Chromecast, AirPlay, network players | 0.8 | P2 |
| `ssdp_upnp` | DLNA renderers, some AVRs and consoles | 0.7 | P2 |
| `bluetooth` | speakers, controllers, phones | 0.7 | P2 |
| `adb` | debug-only, dev boxes | 0.9 | P2 |
| `ip_scan` | last resort, opt-in — a scan is a network side effect | 0.3 | P2 |
| `matter` / `home_assistant` | lights, AC, sensors, with real capabilities | 0.9 | P2 |
| `vision` | "there is a console under the TV" | 0.4 | P3 |

Merge rules: identity is decided by the strongest available key — MAC, then CEC
physical address, then HDMI port, then a normalised name. Two observations that
merge combine `discoveredBy` and take the **max** confidence per field, not the
newest, because CEC knowing the name does not make mDNS wrong about the IP.

## Interaction with the World Model

The Device Graph is *structure*; volatile per-device state (power, current app)
lives in the World Model under `devices.<id>.*`. The split keeps a slow-changing
topology from being rewritten by every power poll, and lets a device be "known to
exist, current state unknown" — the normal case.

## P0 scope

`manual` and `platform` sources only. The mock adapter registers a living room
with a TV, a PS5 on HDMI2 and an STB on HDMI3, which is enough for Scenario B to
be a real plan (`ps5` → `connection.port` → `tv.input.switch`) rather than a
hard-coded `hdmi2`.

That substitution is the entire point: **nowhere in the core does the string
`hdmi2` appear for the PS5 case.** It is looked up.
