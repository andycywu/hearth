/**
 * Ask the device what it can actually do, before telling anyone what we can do.
 *
 * `PlatformProvider.has()` answers a *structural* question: is there a `system`
 * object, is there a `voice` object. That is the right gate for the optional
 * members, and it is no gate at all for a capability missing *inside* a required
 * one. `system` exists on every adapter, so the volume tools are always
 * registered — including on firmware with no audio API at all.
 *
 * Which is not hypothetical. On the Tizen TV emulator:
 *
 *     > what can you do
 *     I can set volume, mute, switch input, or open an app.
 *     > set volume to 30
 *     This TV can't do that: no audio control API on this build
 *
 * It promised, then declined. webOS did the same for volume and for apps. The
 * comment above `createTvTools` claimed "the LLM never sees a tool the current
 * device can't fulfil", and that was only ever true of `media` and `voice`.
 *
 * So: run the cheap read of each capability group at boot and withdraw the tools
 * whose read says *unsupported*. Three rules make this safe rather than clever:
 *
 *  - **Reads only.** Never `setVolume` or `powerStandby` to find out; a probe
 *    that changes the TV to ask a question is worse than the question.
 *  - **`unsupported` only.** A `failed` or `offline` read is a bad moment, not a
 *    missing capability, and withdrawing a working tool over one is worse than
 *    leaving it.
 *  - **A read vouches for its group.** In every adapter here, read and write go
 *    through the same platform object — Tizen's `audio()`, webOS's `luna()` — so
 *    a read that reports the API absent means the write cannot work either. It
 *    is an inference, and it is the one this design rests on.
 *
 * What it cannot cover: capabilities with no side-effect-free read.
 * `set_input_source` can only be probed by doing it, and `getInputSource` says
 * nothing about whether *setting* works — on Tizen the read succeeds and the
 * write is unsupported by design. Those rely on the agent withdrawing a tool the
 * first time it answers `unsupported` at call time, which is also the backstop
 * for an API that loads later than boot.
 */

import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import { classifyToolError } from "./result.js";

export interface CapabilityProbe {
  /** Tool names withdrawn, in probe order. */
  withdrawn: string[];
  /** One line per withdrawal, for `?diag` and boot logs. */
  notes: string[];
}

interface ProbeSpec {
  /** What the report calls this group. */
  what: string;
  /** A read that touches the same platform API the group's writes use. */
  read: (p: PlatformProvider) => Promise<unknown>;
  /** Tools this read vouches for. */
  tools: string[];
}

const PROBES: ProbeSpec[] = [
  {
    what: "volume",
    read: (p) => p.system.getVolume(),
    tools: ["get_volume", "set_volume"],
  },
  {
    what: "mute",
    read: (p) => p.system.getMute(),
    // `get_volume` reports mute too, so it is already covered by the volume
    // probe; listing it again would be harmless but says the wrong thing about
    // which read vouches for what.
    tools: ["get_mute", "set_mute"],
  },
  {
    what: "apps",
    read: (p) => p.apps.listInstalledApps(),
    // All three depend on the same listing: search filters it, and launch is
    // reached through search. A device that cannot enumerate apps cannot offer
    // any of them.
    tools: ["list_apps", "search_app_by_name", "launch_app"],
  },
  {
    what: "input source",
    read: (p) => p.system.getInputSource(),
    // Only the read. `set_input_source` is a separate, usually signing-gated
    // API — on Tizen the read works and the write never will — so inferring one
    // from the other would withdraw a working tool or keep a dead one.
    tools: ["get_input_source"],
  },
];

/**
 * Probe every group and return which tools this device cannot back.
 *
 * Probes run together: they are independent reads and a TV boot should not pay
 * for them in series. Nothing is withdrawn here — the caller decides, so this
 * stays a question and not a side effect.
 */
export async function probeCapabilities(platform: PlatformProvider): Promise<CapabilityProbe> {
  const results = await Promise.all(PROBES.map(async (probe) => {
    try {
      await probe.read(platform);
      return null;
    } catch (err) {
      const classified = classifyToolError(err);
      if (classified.ok || classified.error !== "unsupported") return null;
      return { probe, message: classified.message };
    }
  }));

  const withdrawn: string[] = [];
  const notes: string[] = [];
  for (const hit of results) {
    if (!hit) continue;
    withdrawn.push(...hit.probe.tools);
    notes.push(`${hit.probe.what}: unsupported on this device — ${hit.message}`);
  }
  return { withdrawn, notes };
}
