import type { KeyDirection } from "./keyboard.js";

/**
 * Map a DOM `keydown` to a remote-control intent.
 *
 * Every host's remote arrives as a normal key event — Android TV's D-pad becomes
 * arrow keys in the WebView, and Tizen's remote sends the same key codes plus
 * its own for Back. Handled here so no host repeats the mapping.
 *
 * Its own module because it is *not* part of the on-screen keyboard, even though
 * it lived inside it. The microphone button needs it in every build, so a build
 * with no keyboard was still dragging the whole 5.8 KB renderer in for these
 * thirty lines — 2.0 KB of a bundle that had just been told it wanted neither.
 */
export function remoteIntent(
  e: Pick<KeyboardEvent, "key" | "keyCode">,
): KeyDirection | "press" | "back" | "mic" | undefined {
  switch (e.key) {
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    case "ArrowLeft": return "left";
    case "ArrowRight": return "right";
    case "Enter": return "press";
    case "Backspace": return "back";
    default: break;
  }
  // Below here we're reading raw key codes, which only makes sense for buttons
  // the engine couldn't name. Guarding on that matters: SEARCH is 84, and so is
  // "T" — without this, typing `t` opened the microphone.
  const named = typeof e.key === "string" && e.key !== "" && e.key !== "Unidentified";
  if (named) return undefined;

  // Tizen's remote sends Back as 10009.
  if (e.keyCode === 10009) return "back";
  // The remote's voice/search button, so speech isn't reachable only through
  // the on-screen keyboard's mic key — with the keyboard hidden there was no
  // way to start listening at all. Android TV: SEARCH 84, VOICE_ASSIST 231.
  // Tizen's Smart remote sends 10224 for its mic.
  if (e.keyCode === 84 || e.keyCode === 231 || e.keyCode === 10224) return "mic";
  return undefined;
}
