/**
 * An on-screen keyboard a remote control can drive.
 *
 * A TV has no keyboard and four arrow keys, so text entry has to be a grid you
 * walk. Written here rather than delegating to each platform's IME because the
 * IME route is capability-gated per vendor and needs a focused input the WebView
 * may not get; a grid of divs works identically on all four hosts with no
 * privileges at all.
 *
 * Navigation is `createKeyboardModel()`, pure and testable — the ragged-row
 * clamping is the part that's easy to get wrong.
 */

import { TV_PALETTE, TV_FONT as FONT } from "./theme.js";
import { remoteIntent } from "./remote-keys.js";

export type KeyDirection = "up" | "down" | "left" | "right";

/**
 * A key's effect. Anything without an `action` inserts `value ?? label`.
 *
 * `layout` switches to another named layout, which is how CJK is handled — see
 * `LAYOUTS` for what each one can and can't do.
 */
export type KeyAction = "space" | "delete" | "clear" | "submit" | "mic" | "layout";

export interface KeyboardKey {
  label: string;
  /** Inserted text, when it differs from the label. */
  value?: string;
  action?: KeyAction;
  /** Target layout name, for `action: "layout"`. */
  layout?: string;
  /** Relative width, for the renderer. Default 1. */
  width?: number;
}

export interface KeyboardModelState {
  text: string;
  row: number;
  col: number;
  /** Which layout is showing, so the renderer can rebuild its grid. */
  layout: string;
}

export interface KeyboardModel {
  state(): KeyboardModelState;
  rows(): readonly (readonly KeyboardKey[])[];
  /** The key under the cursor. */
  focused(): KeyboardKey;
  move(dir: KeyDirection): void;
  /**
   * Activate the focused key. Returns what the caller has to act on: text to
   * submit, or a request to start listening. Everything else only edits the
   * field, which the model handles itself.
   */
  press(): { submitted: string } | { mic: true } | undefined;
  setText(text: string): void;
  subscribe(cb: (state: KeyboardModelState) => void): () => void;
}

const KEY = (label: string): KeyboardKey => ({ label });

/**
 * Lowercase only, on purpose: the agent matches case-insensitively, and a shift
 * key would cost a whole extra mode for no gain on a TV.
 */
export const DEFAULT_TV_KEYBOARD: readonly (readonly KeyboardKey[])[] = [
  "1234567890".split("").map(KEY),
  "qwertyuiop".split("").map(KEY),
  "asdfghjkl".split("").map(KEY),
  [
    ..."zxcvbnm".split("").map(KEY),
    // Switching to a layout that isn't installed is a no-op, so these are safe
    // even when someone passes a bare grid with no layout set.
    { label: "かな", action: "layout" as const, layout: "kana", width: 2 },
    { label: "常用", action: "layout" as const, layout: "phrases", width: 2 },
  ],
  [
    { label: "space", action: "space", width: 3 },
    { label: "⌫", action: "delete", width: 1 },
    { label: "clear", action: "clear", width: 2 },
    { label: "Send", action: "submit", width: 2 },
  ],
];

const CHAR = (label: string): KeyboardKey => ({ label });
const TO = (label: string, layout: string): KeyboardKey =>
  ({ label, action: "layout", layout, width: 2 });

/** The controls every layout needs, so they can't drift apart. */
const CONTROLS: readonly KeyboardKey[] = [
  { label: "␣", action: "space", width: 2 },
  { label: "⌫", action: "delete" },
  { label: "clear", action: "clear", width: 2 },
  { label: "Send", action: "submit", width: 2 },
];

/**
 * Japanese kana. Real character entry: kana *are* text, so a grid is enough and
 * no IME is involved.
 *
 * Worth knowing: the offline scripted brain matches patterns like 音量, written
 * in kanji, so kana typed here won't reach it. A real model reads kana fine.
 * That's a limit of the demo brain, not of the input.
 */
const KANA_ROWS: readonly (readonly KeyboardKey[])[] = [
  "あいうえおかきくけこ".split("").map(CHAR),
  "さしすせそたちつてと".split("").map(CHAR),
  "なにぬねのはひふへほ".split("").map(CHAR),
  "まみむめもやゆよらり".split("").map(CHAR),
  "るれろわをんがざだば".split("").map(CHAR),
  [...("ぱーっ".split("").map(CHAR)), TO("abc", "latin"), TO("常用", "phrases")],
  CONTROLS,
];

/**
 * Ready-made commands, which is how Chinese is handled.
 *
 * Chinese characters cannot be typed from a grid: you need an IME with a
 * dictionary, phonetic input and a candidate list, and that is a large component
 * to own — for a remote control with four arrow keys it would also be miserable
 * to use. A TV's honest answer is the one Netflix and YouTube already give for
 * search: offer the things worth saying. It doubles as discoverability, which a
 * TV agent needs anyway.
 *
 * These match what the offline brain understands, so they work with no model.
 */
const PHRASE_ROWS: readonly (readonly KeyboardKey[])[] = [
  [
    { label: "音量調到 30", width: 4 },
    { label: "大聲一點", width: 3 },
    { label: "小聲一點", width: 3 },
  ],
  [
    { label: "現在音量多少?", width: 4 },
    { label: "靜音", width: 3 },
    { label: "取消靜音", width: 3 },
  ],
  [
    { label: "有哪些應用程式?", width: 5 },
    { label: "開啟 Netflix", width: 5 },
  ],
  [
    { label: "音量を50にして", width: 5 },
    { label: "音量はいくつ?", width: 5 },
  ],
  [TO("abc", "latin"), TO("かな", "kana"), ...CONTROLS],
];

/** Every layout the keyboard can switch between, by name. */
export const LAYOUTS: Readonly<Record<string, readonly (readonly KeyboardKey[])[]>> = {
  latin: DEFAULT_TV_KEYBOARD,
  kana: KANA_ROWS,
  phrases: PHRASE_ROWS,
};

export function createKeyboardModel(
  input:
    | readonly (readonly KeyboardKey[])[]
    | Readonly<Record<string, readonly (readonly KeyboardKey[])[]>> = DEFAULT_TV_KEYBOARD,
  initialLayout = "latin",
): KeyboardModel {
  // Accept a bare grid or a set of named layouts, so a caller that only wants
  // one keyboard doesn't have to know layouts exist.
  const layouts: Record<string, readonly (readonly KeyboardKey[])[]> = Array.isArray(input)
    ? { [initialLayout]: input as readonly (readonly KeyboardKey[])[] }
    : { ...(input as Record<string, readonly (readonly KeyboardKey[])[]>) };

  for (const [name, r] of Object.entries(layouts)) {
    if (!r.length || r.some((row) => row.length === 0)) {
      throw new Error(`keyboard layout "${name}" needs at least one row and no empty rows`);
    }
  }
  let layoutName = layouts[initialLayout] ? initialLayout : Object.keys(layouts)[0]!;
  let rows = layouts[layoutName]!;

  let text = "";
  let row = 0;
  let col = 0;
  /**
   * The column the user actually aimed for, kept across vertical moves.
   *
   * Without it, walking down through a short row and back up strands you at the
   * short row's last column — the cursor drifts left every time you pass a gap,
   * which feels broken on a remote.
   */
  let desiredCol = 0;

  const subs = new Set<(s: KeyboardModelState) => void>();
  const emit = (): void => {
    const snap: KeyboardModelState = { text, row, col, layout: layoutName };
    subs.forEach((cb) => cb(snap));
  };

  const clampCol = (): void => {
    const last = rows[row]!.length - 1;
    col = desiredCol > last ? last : desiredCol;
  };

  return {
    state: () => ({ text, row, col, layout: layoutName }),
    rows: () => rows,
    focused: () => rows[row]![col]!,

    move: (dir) => {
      switch (dir) {
        case "left":
          // Wrap within the row: on a remote, walking off one end and coming
          // back round beats stopping dead.
          col = col === 0 ? rows[row]!.length - 1 : col - 1;
          desiredCol = col;
          break;
        case "right":
          col = col === rows[row]!.length - 1 ? 0 : col + 1;
          desiredCol = col;
          break;
        case "up":
          row = row === 0 ? rows.length - 1 : row - 1;
          clampCol();
          break;
        case "down":
          row = row === rows.length - 1 ? 0 : row + 1;
          clampCol();
          break;
      }
      emit();
    },

    press: () => {
      const key = rows[row]![col]!;
      switch (key.action) {
        case "layout": {
          const next = key.layout && layouts[key.layout];
          if (!next) break;
          layoutName = key.layout!;
          rows = next;
          // Land on the first key: the old position may not exist here, and a
          // predictable starting point beats a clamped guess after a full
          // change of grid.
          row = 0;
          col = 0;
          desiredCol = 0;
          break;
        }
        case "mic":
          // The model doesn't own the microphone — capture is the host's, and it
          // pushes any transcript back through `setText`.
          return { mic: true };
        case "submit": {
          const submitted = text.trim();
          if (!submitted) return undefined;
          text = "";
          emit();
          return { submitted };
        }
        case "space":
          text += " ";
          break;
        case "delete":
          text = text.slice(0, -1);
          break;
        case "clear":
          text = "";
          break;
        default:
          text += key.value ?? key.label;
      }
      emit();
      return undefined;
    },

    setText: (next) => {
      text = next;
      emit();
    },

    subscribe: (cb) => {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
  };
}

export interface OnScreenKeyboardOptions {
  /** Element to mount into. Defaults to document.body. */
  mount?: HTMLElement;
  /** Layout override. Defaults to `DEFAULT_TV_KEYBOARD`. */
  rows?: readonly (readonly KeyboardKey[])[];
  /** Called with the trimmed text when Send is pressed. */
  onSubmit: (text: string) => void | Promise<void>;
  /**
   * Supply this to add a microphone key. Only pass it when the platform actually
   * has a voice pipeline — a dead mic key is worse than no mic key.
   */
  onMic?: () => void;
  /**
   * Which layout to open on. Defaults to `latin`; a build for a market that
   * mostly speaks Chinese would sensibly start on `phrases`.
   */
  layout?: string;
  /** Start hidden and wait for `show()`. Default false. */
  hidden?: boolean;
}

export interface OnScreenKeyboardController {
  show(): void;
  hide(): void;
  toggle(): void;
  visible(): boolean;
  /** Put text in the field — a voice transcript the user can then correct. */
  setText(text: string): void;
  destroy(): void;
}

/**
 * Render the keyboard and drive it from the remote.
 *
 * Styled inline rather than through a stylesheet so it looks the same on four
 * hosts whose CSS was written before it existed, and so a host can adopt it
 * without editing any markup.
 */
export function mountOnScreenKeyboard(
  opts: OnScreenKeyboardOptions,
): OnScreenKeyboardController {
  if (typeof document === "undefined") {
    throw new Error("mountOnScreenKeyboard requires a DOM environment");
  }
  // The mic key is added here rather than baked into the layouts, so a platform
  // with no voice pipeline never shows a key that can't work. It goes on every
  // layout: speech is the one input that doesn't care which script you're in,
  // and it's the fastest way to enter Chinese, where typing isn't an option.
  const withMic = (rows: readonly (readonly KeyboardKey[])[]) =>
    rows.map((row, i) =>
      i === rows.length - 1
        ? [{ label: "🎤 Speak", action: "mic" as const, width: 2 }, ...row]
        : row);

  const layouts = opts.rows
    ? { latin: opts.onMic ? withMic(opts.rows) : opts.rows }
    : Object.fromEntries(
        Object.entries(LAYOUTS).map(([name, rows]) => [name, opts.onMic ? withMic(rows) : rows]),
      );
  const model = createKeyboardModel(layouts, opts.layout ?? "latin");
  const mount = opts.mount ?? document.body;

  const root = document.createElement("div");
  root.id = "osk";
  root.style.cssText = [
    "position:fixed", "left:0", "right:0", "bottom:0", "z-index:2",
    "padding:2.4vh 4vw 3vh", "box-sizing:border-box",
    // A sheet the content behind fades into, rather than a hard black bar
    // cutting the screen in half. Nearly solid under the keys and only a short
    // fade at the very top: with a long fade, whatever is behind the app showed
    // through the text field and the top row, which read as a rendering bug.
    "background:linear-gradient(to top," +
      "rgba(9,12,20,.97) 0%,rgba(9,12,20,.97) 72%,rgba(14,19,30,.86) 88%,rgba(20,26,38,0) 100%)",
    "-webkit-backdrop-filter:blur(1.6vh)", "backdrop-filter:blur(1.6vh)",
    `color:${TV_PALETTE.text}`, `font-family:${FONT}`, "text-align:center",
  ].join(";");

  // The text field reads as an input, with a caret, instead of as a line of
  // status text — otherwise there is nothing to say where typing goes.
  const field = document.createElement("div");
  field.style.cssText = [
    "display:inline-block", "min-width:40vw", "max-width:80vw",
    "padding:1.1vh 2vw", "margin-bottom:2vh",
    "font-size:2.8vh", "line-height:1.3", "text-align:left",
    "border-radius:1vh", `border:1px solid ${TV_PALETTE.edge}`,
    `background:${TV_PALETTE.glass}`,
    "white-space:pre-wrap", "word-break:break-word",
  ].join(";");
  root.appendChild(field);

  const grid = document.createElement("div");
  root.appendChild(grid);

  // One element per key, kept so a cursor move only touches styles — a TV
  // WebView is slow enough that rebuilding the grid every move is visible.
  // Rebuilt only when the layout changes, which is rare and unavoidable.
  let cells: HTMLElement[][] = [];
  let builtLayout = "";

  function buildGrid(): void {
    grid.textContent = "";
    cells = model.rows().map((row) => {
      const rowEl = document.createElement("div");
      rowEl.style.cssText = "display:flex;gap:.9vw;justify-content:center;margin-bottom:1vh";
      const rowCells = row.map((key) => {
        const cell = document.createElement("div");
        cell.textContent = key.label;
        cell.style.cssText = [
          `flex:${key.width ?? 1} 0 auto`,
          "min-width:5vw", "padding:1.3vh .6vw",
          "border-radius:1vh", "font-size:2.4vh",
          `border:1px solid ${TV_PALETTE.edge}`, `background:${TV_PALETTE.glass}`,
          // Phrases are whole sentences; stop them wrapping mid-key.
          "white-space:nowrap",
          // Only the focused key animates, and only its own properties: a TV
          // WebView will happily drop frames if asked to transition a grid.
          "transition:background .12s linear,transform .12s ease-out",
        ].join(";");
        rowEl.appendChild(cell);
        return cell;
      });
      grid.appendChild(rowEl);
      return rowCells;
    });
    builtLayout = model.state().layout;
  }

  function render(): void {
    const { text, row, col, layout } = model.state();
    if (layout !== builtLayout) buildGrid();
    field.textContent = text || "Type a command…";
    field.style.color = text ? TV_PALETTE.text : TV_PALETTE.faint;
    cells.forEach((rowCells, r) => {
      rowCells.forEach((cell, c) => {
        const on = r === row && c === col;
        cell.style.background = on ? TV_PALETTE.accent : TV_PALETTE.glass;
        cell.style.color = on ? "#08101c" : TV_PALETTE.text;
        cell.style.borderColor = on ? TV_PALETTE.accent : TV_PALETTE.edge;
        // Lift the focused key. On a grid this size, colour alone is easy to
        // lose track of from across a room.
        cell.style.transform = on ? "scale(1.08)" : "scale(1)";
        cell.style.boxShadow = on ? `0 0 2.4vh ${TV_PALETTE.accent}55` : "none";
      });
    });
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (root.hidden) return;
    const intent = remoteIntent(e);
    if (!intent) return;
    e.preventDefault();
    if (intent === "back") {
      hide();
      return;
    }
    if (intent === "mic") {
      opts.onMic?.();
      return;
    }
    if (intent === "press") {
      const result = model.press();
      if (result && "submitted" in result) void opts.onSubmit(result.submitted);
      else if (result) opts.onMic?.();
      return;
    }
    model.move(intent);
  }

  function show(): void { root.hidden = false; render(); }
  function hide(): void { root.hidden = true; }

  model.subscribe(render);
  mount.appendChild(root);
  root.hidden = opts.hidden ?? false;
  render();
  document.addEventListener("keydown", onKeyDown);

  return {
    show,
    hide,
    toggle: () => (root.hidden ? show() : hide()),
    visible: () => !root.hidden,
    setText: (text) => model.setText(text),
    destroy: () => {
      document.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}
