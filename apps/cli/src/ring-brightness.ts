/**
 * "Make your lights dimmer" — the status ring's brightness, as something Hearth can be asked to change.
 *
 * The ring was found too bright in a living room in the evening; 5% of its built-in levels is the default since. A room
 * with more light around it, or a demonstration across a shop floor, wants more, and the person in front of it should not
 * need a terminal to say so. The change is painted at once and written to the config, so it is still true after a restart.
 *
 * Not a capability: it is not the room's state, there is no goal to plan. And not the television's brightness — the
 * description says so, because "brighter" said to a television is far more often about the picture.
 */
import { defineTool, type Tool } from "@hearthkit/core";
import type { StatusRing } from "@hearthkit/adapter-linux";
import { loadConfig, saveConfig } from "./config.js";

/** Percent of the ring's built-in levels. Chosen with the owner watching the ring at 10, 25 and 75 (2026-11-04). */
export const DEFAULT_LED_BRIGHTNESS = 5;

export interface RingBrightnessDeps {
  /** Make the new percent the one the next start uses. Defaults to `ledBrightness` in ~/.config/hearth/config.json. */
  save?: (percent: number) => Promise<void>;
}

const NOTE = "The ring cannot be read back: this is the level written to it, not one seen on it.";

const saveToConfig = async (percent: number): Promise<void> => {
  await saveConfig({ ...(await loadConfig()), ledBrightness: percent });
};

export function ringBrightnessTools(ring: StatusRing, deps: RingBrightnessDeps = {}): Tool[] {
  if (!ring.setLevel || !ring.level) return [];
  const setLevel = ring.setLevel.bind(ring);
  const level = ring.level.bind(ring);
  const percent = (): number => Math.round(level() * 1000) / 10;
  const save = deps.save ?? saveToConfig;
  return [
    defineTool(
      {
        name: "get_led_brightness",
        description:
          "Read the brightness of the LED status ring on this box (the ring of lights on the microphone, not the television's picture), " +
          "as a percent of its built-in levels. " + NOTE,
        parameters: {},
      },
      async () => ({ brightness_percent: percent(), read_back: false, note: NOTE }),
    ),
    defineTool<{ percent: number }>(
      {
        name: "set_led_brightness",
        description:
          "Set the brightness of the LED status ring on this box — the ring of lights on the microphone — as a percent (1-100) of its built-in levels. " +
          `${DEFAULT_LED_BRIGHTNESS} is the default, for a dim living room; 25 to 75 suits a brighter room. ` +
          "Only for the lights on this box. For the television's picture brightness this is the wrong tool. Kept after a restart. " + NOTE,
        parameters: { percent: { type: "number", description: "1-100, percent of the built-in levels", required: true } },
      },
      async ({ percent: asked }) => {
        const p = Number(asked);
        if (!Number.isFinite(p) || p < 1 || p > 100) throw new Error(`brightness must be a percent from 1 to 100 (got ${String(asked)})`);
        await setLevel(p / 100);
        const now = percent();
        let saved: true | string = true;
        try { await save(now); } catch (err) { saved = err instanceof Error ? err.message : String(err); }
        return {
          brightness_percent: now,
          read_back: false,
          ...(saved === true ? { kept_after_restart: true } : { kept_after_restart: false, why_not_kept: saved }),
          note: NOTE,
        };
      },
    ),
  ];
}
