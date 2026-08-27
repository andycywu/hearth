import { describe, it, expect } from "vitest";
import { remoteIntent } from "./remote-keys.js";

/**
 * Moved out of keyboard.test.ts along with the function itself: mapping a
 * remote's keys is not part of drawing an on-screen keyboard, and a build with
 * no keyboard still has a remote.
 */

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
