import { remoteIntent } from "./remote-keys.js";
import { TV_PALETTE, TV_FONT } from "./theme.js";

/**
 * A confirmation dialog you can actually answer from a sofa.
 *
 * `window.confirm` was the placeholder: it blocks the JS thread, isn't focusable
 * with a D-pad on every TV WebView, and on some builds is stubbed out entirely —
 * which silently turned the confirmation gate into "always approve". This is a
 * DOM dialog driven by the same remote intents as the keyboard.
 *
 * Styled inline for the same reason the keyboard is: it has to look identical on
 * four hosts whose stylesheets were written before it existed.
 */

export interface TvConfirmDialogOptions {
  /** Element to mount into. Defaults to document.body. */
  mount?: HTMLElement;
  /**
   * Which button starts focused. Defaults to **deny**.
   *
   * The gate exists to stop side effects the viewer didn't ask for, so a stray
   * OK press should decline rather than launch something. Hosts that would
   * rather optimise for the common case can flip it.
   */
  defaultChoice?: "allow" | "deny";
  /**
   * Answer with `defaultChoice` if nobody responds, in ms. 0 disables it.
   *
   * A modal nobody dismisses is worse on a TV than on a desktop: there may be no
   * pointer, and the agent's turn timeout would fire leaving the dialog on
   * screen with nothing behind it.
   */
  timeoutMs?: number;
  allowLabel?: string;
  denyLabel?: string;
}

export interface TvConfirmDialog {
  /** Ask, resolving to the viewer's answer. Serialised if one is already open. */
  ask(question: string): Promise<boolean>;
  destroy(): void;
}

/** What a remote press does to an open dialog. */
export type ConfirmDialogAction =
  | { toggle: true }
  | { answer: boolean }
  | undefined;

/**
 * The dialog's whole behaviour, minus the DOM — extracted so it can be tested,
 * since this package has no browser environment in CI and the rules here are
 * the part worth pinning.
 */
export function confirmDialogAction(
  intent: ReturnType<typeof remoteIntent>,
  allowFocused: boolean,
): ConfirmDialogAction {
  switch (intent) {
    case "left":
    case "right":
      // Two buttons, so either direction just swaps: on a remote, requiring the
      // "correct" direction to reach a visible button is a papercut.
      return { toggle: true };
    case "press":
      return { answer: allowFocused };
    case "back":
      // Backing out of a permission prompt means no, whatever is focused.
      return { answer: false };
    default:
      return undefined;
  }
}

export function createTvConfirmDialog(opts: TvConfirmDialogOptions = {}): TvConfirmDialog {
  if (typeof document === "undefined") {
    throw new Error("createTvConfirmDialog requires a DOM environment");
  }
  const mount = opts.mount ?? document.body;
  const defaultAllow = opts.defaultChoice === "allow";
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const root = document.createElement("div");
  root.id = "tv-confirm";
  root.style.cssText = [
    "position:fixed", "inset:0", "z-index:10",
    // Visibility is `display`, not the `hidden` attribute: an inline
    // `display:flex` beats the user-agent's `[hidden] { display: none }`, so
    // setting `hidden` left the dialog on screen after it had been answered.
    "display:none", "align-items:center", "justify-content:center",
    // Darken and blur what's behind rather than hiding it: the viewer needs to
    // see they are still in the same place, being asked one question.
    "background:rgba(4,6,12,.62)",
    "-webkit-backdrop-filter:blur(1.2vh)", "backdrop-filter:blur(1.2vh)",
    `color:${TV_PALETTE.text}`, `font-family:${TV_FONT}`,
  ].join(";");

  const panel = document.createElement("div");
  panel.style.cssText = [
    "max-width:70vw", "padding:6vh 6vw", "border-radius:2vh",
    `background:${TV_PALETTE.glassStrong}`, `border:1px solid ${TV_PALETTE.edge}`,
    "box-shadow:0 4vh 8vh rgba(0,0,0,.55)", "text-align:center",
  ].join(";");
  root.appendChild(panel);

  const text = document.createElement("div");
  text.style.cssText = "font-size:3.4vh;line-height:1.45;margin-bottom:4.5vh";
  panel.appendChild(text);

  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:2vw;justify-content:center";
  panel.appendChild(buttons);

  const makeButton = (label: string): HTMLElement => {
    const b = document.createElement("div");
    b.textContent = label;
    b.style.cssText = [
      "min-width:14vw", "padding:1.9vh 2vw", "border-radius:1.2vh",
      "font-size:2.8vh", `border:1px solid ${TV_PALETTE.edge}`,
      `background:${TV_PALETTE.glass}`,
      "transition:background .12s linear,transform .12s ease-out",
    ].join(";");
    buttons.appendChild(b);
    return b;
  };
  // Deny first: on a left-to-right grid the safe option should be the one you
  // land on when you back away from the affirmative.
  const denyButton = makeButton(opts.denyLabel ?? "No");
  const allowButton = makeButton(opts.allowLabel ?? "Yes");

  mount.appendChild(root);

  let allowFocused = defaultAllow;
  let resolveCurrent: ((answer: boolean) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Serialises overlapping asks; the agent is sequential but hosts may not be. */
  let queue: Promise<unknown> = Promise.resolve();

  function paint(): void {
    for (const [button, on] of [[allowButton, allowFocused], [denyButton, !allowFocused]] as const) {
      button.style.background = on ? TV_PALETTE.accent : TV_PALETTE.glass;
      button.style.color = on ? "#08101c" : TV_PALETTE.text;
      button.style.borderColor = on ? TV_PALETTE.accent : TV_PALETTE.edge;
      button.style.transform = on ? "scale(1.06)" : "scale(1)";
      button.style.boxShadow = on ? `0 0 3vh ${TV_PALETTE.accent}55` : "none";
    }
  }

  function finish(answer: boolean): void {
    if (!resolveCurrent) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    document.removeEventListener("keydown", onKeyDown, true);
    delete (globalThis as { __tvBack?: unknown }).__tvBack;
    root.style.display = "none";
    const resolve = resolveCurrent;
    resolveCurrent = undefined;
    resolve(answer);
  }

  function onKeyDown(e: KeyboardEvent): void {
    const action = confirmDialogAction(remoteIntent(e), allowFocused);
    if (!action) return;
    // Capture phase *and* stopPropagation: the on-screen keyboard listens on
    // document too, and a modal that lets keys through to it would move the
    // cursor behind the dialog while you answer.
    e.preventDefault();
    e.stopPropagation();
    if ("toggle" in action) {
      allowFocused = !allowFocused;
      paint();
      return;
    }
    finish(action.answer);
  }

  function open(question: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      resolveCurrent = resolve;
      text.textContent = question;
      allowFocused = defaultAllow;
      paint();
      root.style.display = "flex";
      document.addEventListener("keydown", onKeyDown, true);
      // Android delivers the hardware BACK key to the Activity, not to the
      // WebView as a key event — pressing it closed the whole app instead of
      // declining. The host asks this hook first and only falls back to its own
      // behaviour when nothing claims the press. Tizen's remote does arrive as a
      // key event (10009), so `onKeyDown` covers it there.
      (globalThis as { __tvBack?: () => boolean }).__tvBack = () => {
        finish(false);
        return true;
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          console.info(`[confirm] no answer in ${timeoutMs}ms — ${defaultAllow ? "approved" : "declined"}`);
          finish(defaultAllow);
        }, timeoutMs);
      }
    });
  }

  return {
    ask: (question) => {
      const next = queue.then(() => open(question));
      // Keep the chain alive even if a caller ignores a rejection.
      queue = next.catch(() => undefined);
      return next;
    },
    destroy: () => {
      finish(false);
      document.removeEventListener("keydown", onKeyDown, true);
      root.remove();
    },
  };
}
