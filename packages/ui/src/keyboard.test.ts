import { describe, it, expect } from "vitest";
import {
  createKeyboardModel, remoteIntent, DEFAULT_TV_KEYBOARD, type KeyboardKey,
} from "./keyboard.js";

/** Ragged on purpose: 3 / 1 / 2 columns exercises the clamping. */
const RAGGED: readonly (readonly KeyboardKey[])[] = [
  [{ label: "a" }, { label: "b" }, { label: "c" }],
  [{ label: "d" }],
  [{ label: "e" }, { label: "Send", action: "submit" }],
];

const at = (m: ReturnType<typeof createKeyboardModel>) => m.focused().label;

describe("createKeyboardModel", () => {
  it("starts on the first key with empty text", () => {
    const m = createKeyboardModel(RAGGED);
    expect(m.state()).toEqual({ text: "", row: 0, col: 0 });
    expect(at(m)).toBe("a");
  });

  it("rejects a layout it can't navigate", () => {
    expect(() => createKeyboardModel([])).toThrow(/at least one row/);
    expect(() => createKeyboardModel([[]])).toThrow(/no empty rows/);
  });

  it("types the focused key into the text", () => {
    const m = createKeyboardModel(RAGGED);
    m.press();
    m.move("right");
    m.press();
    expect(m.state().text).toBe("ab");
  });

  it("uses value over label when they differ", () => {
    const m = createKeyboardModel([[{ label: "␣", value: " " }]]);
    m.press();
    expect(m.state().text).toBe(" ");
  });

  it("wraps horizontally rather than stopping dead", () => {
    const m = createKeyboardModel(RAGGED);
    m.move("left");
    expect(at(m)).toBe("c");
    m.move("right");
    expect(at(m)).toBe("a");
  });

  it("wraps vertically too", () => {
    const m = createKeyboardModel(RAGGED);
    m.move("up");
    expect(m.state().row).toBe(2);
    m.move("down");
    expect(m.state().row).toBe(0);
  });

  it("clamps into a shorter row instead of pointing at nothing", () => {
    const m = createKeyboardModel(RAGGED);
    m.move("right");
    m.move("right");        // row 0, col 2 ("c")
    m.move("down");         // row 1 has one key
    expect(m.state()).toMatchObject({ row: 1, col: 0 });
    expect(at(m)).toBe("d");
  });

  it("remembers the column you aimed for across a short row", () => {
    // Walking down past a narrow row and back up used to strand the cursor at
    // that row's last column, so it crept left every time — feels broken.
    const m = createKeyboardModel(RAGGED);
    m.move("right");
    m.move("right");        // aiming at col 2
    m.move("down");         // clamped to col 0
    m.move("up");           // back to a 3-wide row
    expect(m.state().col).toBe(2);
    expect(at(m)).toBe("c");
  });

  it("forgets the aimed column once you move sideways", () => {
    const m = createKeyboardModel(RAGGED);
    m.move("right");
    m.move("right");        // col 2
    m.move("down");         // col 0 (clamped)
    m.move("right");        // deliberate sideways move on the short row: wraps to 0
    m.move("up");
    expect(m.state().col).toBe(0);
  });

  describe("the action keys", () => {
    const withActions = () => createKeyboardModel([[
      { label: "x" },
      { label: "space", action: "space" },
      { label: "⌫", action: "delete" },
      { label: "clear", action: "clear" },
      { label: "Send", action: "submit" },
    ]]);
    const pressAt = (m: ReturnType<typeof createKeyboardModel>, col: number) => {
      for (let i = 0; i < col; i++) m.move("right");
      const r = m.press();
      for (let i = 0; i < col; i++) m.move("left");
      return r;
    };

    it("inserts a space", () => {
      const m = withActions();
      pressAt(m, 0);
      pressAt(m, 1);
      pressAt(m, 0);
      expect(m.state().text).toBe("x x");
    });

    it("deletes the last character, and is safe when empty", () => {
      const m = withActions();
      pressAt(m, 2);
      expect(m.state().text).toBe("");
      pressAt(m, 0);
      pressAt(m, 2);
      expect(m.state().text).toBe("");
    });

    it("clears everything", () => {
      const m = withActions();
      pressAt(m, 0);
      pressAt(m, 0);
      pressAt(m, 3);
      expect(m.state().text).toBe("");
    });

    it("submits the trimmed text and empties the field", () => {
      const m = withActions();
      pressAt(m, 0);
      pressAt(m, 1);       // trailing space
      const r = pressAt(m, 4);
      expect(r).toEqual({ submitted: "x" });
      expect(m.state().text).toBe("");
    });

    it("won't submit nothing", () => {
      const m = withActions();
      expect(pressAt(m, 4)).toBeUndefined();
      pressAt(m, 1);       // only a space
      expect(pressAt(m, 4)).toBeUndefined();
    });
  });

  it("notifies subscribers on typing and on moving", () => {
    const m = createKeyboardModel(RAGGED);
    const seen: string[] = [];
    const off = m.subscribe((s) => seen.push(`${s.row},${s.col}:${s.text}`));
    m.press();
    m.move("right");
    off();
    m.press();
    expect(seen).toEqual(["0,0:a", "0,1:a"]);
  });

  it("accepts text set from outside, e.g. a voice transcript", () => {
    const m = createKeyboardModel(RAGGED);
    m.setText("volume up");
    expect(m.state().text).toBe("volume up");
  });
});

describe("DEFAULT_TV_KEYBOARD", () => {
  it("can reach every key from the origin using only arrows", () => {
    const m = createKeyboardModel();
    const total = DEFAULT_TV_KEYBOARD.reduce((n, r) => n + r.length, 0);
    const seen = new Set<string>();
    for (let r = 0; r < DEFAULT_TV_KEYBOARD.length; r++) {
      for (let c = 0; c < DEFAULT_TV_KEYBOARD[r]!.length; c++) {
        seen.add(`${m.state().row},${m.state().col}`);
        m.move("right");
      }
      m.move("down");
    }
    expect(seen.size).toBe(total);
  });

  it("offers space, delete and submit — the three a TV can't do without", () => {
    const actions = DEFAULT_TV_KEYBOARD.flat().map((k) => k.action).filter(Boolean);
    expect(actions).toContain("space");
    expect(actions).toContain("delete");
    expect(actions).toContain("submit");
  });
});

describe("remoteIntent", () => {
  it("maps the D-pad and OK", () => {
    expect(remoteIntent({ key: "ArrowUp", keyCode: 38 })).toBe("up");
    expect(remoteIntent({ key: "ArrowDown", keyCode: 40 })).toBe("down");
    expect(remoteIntent({ key: "ArrowLeft", keyCode: 37 })).toBe("left");
    expect(remoteIntent({ key: "ArrowRight", keyCode: 39 })).toBe("right");
    expect(remoteIntent({ key: "Enter", keyCode: 13 })).toBe("press");
  });

  it("maps Back, including Tizen's own code", () => {
    expect(remoteIntent({ key: "Backspace", keyCode: 8 })).toBe("back");
    // Tizen's remote sends 10009 with a `key` nothing recognises.
    expect(remoteIntent({ key: "Unidentified", keyCode: 10009 })).toBe("back");
  });

  it("ignores anything else, so typing on a real keyboard still works", () => {
    expect(remoteIntent({ key: "a", keyCode: 65 })).toBeUndefined();
    expect(remoteIntent({ key: "Shift", keyCode: 16 })).toBeUndefined();
  });
});
