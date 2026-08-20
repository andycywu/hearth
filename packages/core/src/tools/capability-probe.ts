/**
 * Ask the device what it can actually do, before telling anyone what we can do.
 *
 * `PlatformProvider.has()` answers a *structural* question: is there a `system`
 * object, is there a `voice` object. That is the right gate for the optional
 * members, and it is no gate at all for a capability missing *inside* a required
 * one. `system` exists on every adapter, so the volume capabilities are always
 * declared — including on firmware with no audio API at all.
 *
 * Which is not hypothetical. On the Tizen TV emulator:
 *
 *     > what can you do
 *     I can set volume, mute, switch input, or open an app.
 *     > set volume to 30
 *     This TV can't do that: no audio control API on this build
 *
 * It promised, then declined. webOS did the same for volume and for apps.
 *
 * So: run the cheap read of each capability group at boot and withdraw what the
 * read says is missing. Three rules make this safe rather than clever:
 *
 *  - **Reads only.** Never `setVolume` or `powerStandby` to find out; a probe
 *    that changes the TV to ask a question is worse than the question.
 *  - **`unsupported` only.** A `failed` or `offline` read is a bad moment, not a
 *    missing capability, and withdrawing a working capability over one is worse
 *    than leaving it.
 *  - **A read vouches only for what it declares.** Which capabilities a read
 *    speaks for is now a field on the read capability itself (`vouchesFor`),
 *    next to the read, instead of a table over here that has to be kept in step
 *    with the catalogue. That inference — read and write go through the same
 *    platform object, so a read reporting the API absent means the write cannot
 *    work either — is true of Tizen's `audio()` and webOS's `luna()`, and it is
 *    the one this design rests on. Where it is *not* true, the capability says
 *    so by vouching only for itself: `tv.input.get_source` reads fine on Tizen
 *    while `tv.input.switch` is signing-gated and never will.
 *
 * What it cannot cover: capabilities with no side-effect-free read. Those rely
 * on the agent withdrawing one the first time it answers `unsupported` at call
 * time, which is also the backstop for an API that loads later than boot.
 */

import type { PlatformProvider } from "@hearthkit/platform-api";
import type { Capability } from "../capabilities/types.js";
import { capabilitiesForPlatform, tvHandlers } from "./tv-tools.js";
import { classifyToolError } from "./result.js";

export interface CapabilityProbe {
  /** Capability ids this device cannot back, in probe order. */
  withdrawn: string[];
  /** The tools those capabilities would have provided. */
  tools: string[];
  /** One line per withdrawal, for `?diag` and boot logs. */
  notes: string[];
  /** Capability id -> why it went away. */
  reasons: Record<string, string>;
}

/**
 * Probe every capability that vouches for others, and report what this device
 * cannot back.
 *
 * Probes run together: they are independent reads and a TV boot should not pay
 * for them in series. Nothing is withdrawn here — the caller decides, so this
 * stays a question and not a side effect.
 */
export async function probeCapabilities(
  platform: PlatformProvider,
  catalogue: Capability[] = capabilitiesForPlatform(platform),
): Promise<CapabilityProbe> {
  const handlers = tvHandlers(platform);
  const byId = new Map(catalogue.map((c) => [c.id, c]));
  const probes = catalogue.filter((c) => c.vouchesFor?.length && handlers[c.id]);

  const results = await Promise.all(probes.map(async (probe) => {
    try {
      await handlers[probe.id]!({});
      return null;
    } catch (err) {
      const classified = classifyToolError(err);
      if (classified.ok || classified.error !== "unsupported") return null;
      return { probe, message: classified.message };
    }
  }));

  const withdrawn: string[] = [];
  const tools: string[] = [];
  const notes: string[] = [];
  const reasons: Record<string, string> = {};

  for (const hit of results) {
    if (!hit) continue;
    const note = `${hit.probe.name}: unsupported on this device — ${hit.message}`;
    notes.push(note);
    for (const id of hit.probe.vouchesFor ?? []) {
      if (reasons[id]) continue;
      withdrawn.push(id);
      reasons[id] = note;
      const tool = byId.get(id)?.tool;
      if (tool) tools.push(tool);
    }
  }
  return { withdrawn, tools, notes, reasons };
}
