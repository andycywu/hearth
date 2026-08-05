import { describe, it, expect } from "vitest";
import {
  createKeyboardModel, remoteIntent, DEFAULT_TV_KEYBOARD, LAYOUTS, type KeyboardKey,
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
    expect(m.state()).toEqual({ text: "", row: 0, col: 0, layout: "latin" });
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

describe("layouts — how CJK is handled", () => {
  /**
   * Walk to the first key matching `label` and press it, using only the moves a
   * remote has. Both axes wrap, and the column must be measured *after* the
   * vertical move because it gets clamped into a shorter row.
   */
  const pressLabel = (m: ReturnType<typeof createKeyboardModel>, label: string) => {
    const rows = m.rows();
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r]!.findIndex((k) => k.label === label);
      if (c === -1) continue;
      const downs = (r - m.state().row + rows.length) % rows.length;
      for (let i = 0; i < downs; i++) m.move("down");
      const rights = (c - m.state().col + rows[r]!.length) % rows[r]!.length;
      for (let i = 0; i < rights; i++) m.move("right");
      expect(m.focused().label).toBe(label);
      return m.press();
    }
    throw new Error(`no key labelled ${label} in layout ${m.state().layout}`);
  };

  it("starts on latin and can reach kana and phrases", () => {
    const m = createKeyboardModel(LAYOUTS, "latin");
    expect(m.state().layout).toBe("latin");
    pressLabel(m, "かな");
    expect(m.state().layout).toBe("kana");
    pressLabel(m, "常用");
    expect(m.state().layout).toBe("phrases");
    pressLabel(m, "abc");
    expect(m.state().layout).toBe("latin");
  });

  it("resets the cursor on switch, so it can't point outside the new grid", () => {
    const m = createKeyboardModel(LAYOUTS, "latin");
    m.move("down"); m.move("right"); m.move("right");
    pressLabel(m, "かな");
    expect(m.state()).toMatchObject({ row: 0, col: 0 });
    expect(m.focused()).toBeDefined();
  });

  it("types real kana — they are text, so no IME is involved", () => {
    const m = createKeyboardModel(LAYOUTS, "kana");
    m.press();               // あ
    m.move("right"); m.press();  // い
    expect(m.state().text).toBe("あい");
  });

  it("keeps typed text across a layout switch", () => {
    // Switching script mid-sentence must not throw away what you wrote.
    const m = createKeyboardModel(LAYOUTS, "latin");
    m.press();               // "1"
    pressLabel(m, "かな");
    m.press();               // あ
    expect(m.state().text).toBe("1あ");
  });

  it("offers Chinese as whole phrases, not characters", () => {
    // Characters can't come from a grid — that needs an IME with a dictionary
    // and a candidate list. This asserts the design decision, so nobody
    // "fixes" it into a broken half-IME later.
    const labels = LAYOUTS.phrases!.flat().map((k) => k.label);
    const chinese = labels.filter((l) => /[一-鿿]/.test(l));
    expect(chinese.length).toBeGreaterThan(3);
    // Each is a full command, not a lone character.
    expect(chinese.every((l) => l.length > 1)).toBe(true);
  });

  it("every phrase inserts itself verbatim, ready to send", () => {
    const m = createKeyboardModel(LAYOUTS, "phrases");
    m.press();
    expect(m.state().text).toBe(LAYOUTS.phrases![0]![0]!.label);
  });

  it("gives every layout a way out and a way to send", () => {
    for (const [name, rows] of Object.entries(LAYOUTS)) {
      const actions = rows.flat().map((k) => k.action);
      expect(actions, `${name} must be able to submit`).toContain("submit");
      expect(actions, `${name} must be able to delete`).toContain("delete");
      if (name !== "latin") {
        expect(actions, `${name} must be able to get back to latin`).toContain("layout");
      }
    }
  });

  it("ignores a switch to a layout that isn't installed", () => {
    // A bare grid still carries the かな/常用 keys; they must be inert, not throw.
    const m = createKeyboardModel(DEFAULT_TV_KEYBOARD);
    pressLabel(m, "かな");
    expect(m.state().layout).toBe("latin");
    expect(m.focused()).toBeDefined();
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

describe("the remote's voice button", () => {
  it("is recognised so speech doesn't depend on the keyboard being open", () => {
    // With the keyboard hidden there was previously no way at all to start
    // listening: the mic key was the only trigger.
    expect(remoteIntent({ key: "Unidentified", keyCode: 84 })).toBe("mic");    // Android SEARCH
    expect(remoteIntent({ key: "Unidentified", keyCode: 231 })).toBe("mic");   // Android VOICE_ASSIST
    expect(remoteIntent({ key: "Unidentified", keyCode: 10224 })).toBe("mic"); // Tizen mic
  });

  it("doesn't shadow ordinary typing", () => {
    // 84 is also "T" on a real keyboard; the `key` check runs first.
    expect(remoteIntent({ key: "t", keyCode: 84 })).toBeUndefined();
  });
});
