import { TV_PALETTE, TV_FONT } from "./theme.js";

/**
 * A visible way to start talking.
 *
 * The avatar screen used to say "press the voice button on your remote" and
 * offer nothing else: no on-screen control, and OK did nothing at all. That is
 * wrong on any device without that key on its remote — and it made the app
 * impossible to use on the Android TV emulator, which has no remote whatsoever,
 * so the only way in was `adb shell input keyevent 84`. Telling someone to press
 * a button they don't have is worse than saying nothing.
 *
 * So the entry point is on screen, and it accepts every input a TV might have:
 * OK/Enter from a D-pad, a pointer click (emulators and touch panels), and the
 * remote's dedicated voice key where there is one.
 *
 * A `<button>`, not a styled div: it is focusable and clickable without any of
 * that being re-implemented, and a screen reader gets something meaningful.
 */

export interface MicButtonOptions {
  /** Element to mount into. Defaults to document.body. */
  mount?: HTMLElement;
  /** Start listening. Called for OK, a click, or a tap. */
  onPress: () => void;
  /** Idle label. Default "Speak". */
  label?: string;
  /**
   * Label while the microphone is open. Default "Speak now".
   *
   * Not "Listening…" — the avatar's phase pill already says that, a few
   * centimetres above, and having both say it reads as a duplicated element
   * rather than two pieces of information. The pill says what the agent is
   * doing; the button says what you should do.
   */
  listeningLabel?: string;
}

export interface MicButtonController {
  /** Reflect the microphone state, so the button doesn't invite a second press. */
  setListening(listening: boolean): void;
  destroy(): void;
}

export function mountMicButton(opts: MicButtonOptions): MicButtonController {
  if (typeof document === "undefined") {
    throw new Error("mountMicButton requires a DOM environment");
  }
  const mount = opts.mount ?? document.body;
  const label = opts.label ?? "Speak";
  const listeningLabel = opts.listeningLabel ?? "Speak now";

  const button = document.createElement("button");
  button.id = "tv-mic";
  button.type = "button";
  button.style.cssText = [
    "position:fixed", "left:50%", "bottom:8vh", "transform:translateX(-50%)",
    "display:flex", "align-items:center", "gap:1vw",
    "padding:1.8vh 3.2vw", "border-radius:6vh",
    `font-family:${TV_FONT}`, "font-size:2.6vh",
    `color:${TV_PALETTE.text}`, `background:${TV_PALETTE.glass}`,
    `border:1px solid ${TV_PALETTE.edge}`,
    "cursor:pointer", "z-index:2",
    "transition:background .12s linear,transform .12s ease-out",
  ].join(";");

  const glyph = document.createElement("span");
  glyph.textContent = "🎤";
  glyph.style.cssText = "font-size:3vh;line-height:1";
  const text = document.createElement("span");
  text.textContent = label;
  button.append(glyph, text);
  mount.appendChild(button);

  // Focused from the start and kept that way: it is the only control on this
  // screen, so there is nowhere else for focus to usefully be, and a TV WebView
  // will otherwise leave focus on the document where OK reaches nothing.
  button.focus();
  const press = (e: Event): void => {
    e.preventDefault();
    opts.onPress();
  };
  button.addEventListener("click", press);

  let listening = false;

  function paint(): void {
    text.textContent = listening ? listeningLabel : label;
    // Accent while idle — it is an invitation. Neutral while listening, because
    // pressing it again does nothing and it shouldn't look like it would.
    button.style.background = listening ? TV_PALETTE.glass : TV_PALETTE.accent;
    button.style.color = listening ? TV_PALETTE.text : "#08101c";
    button.style.borderColor = listening ? TV_PALETTE.edge : TV_PALETTE.accent;
    button.style.transform = listening
      ? "translateX(-50%) scale(1)"
      : "translateX(-50%) scale(1.02)";
    button.style.boxShadow = listening ? "none" : `0 0 3vh ${TV_PALETTE.accent}55`;
  }
  paint();

  return {
    setListening: (next) => {
      if (next === listening) return;
      listening = next;
      paint();
    },
    destroy: () => {
      button.removeEventListener("click", press);
      button.remove();
    },
  };
}
