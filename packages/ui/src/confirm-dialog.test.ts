import { describe, it, expect } from "vitest";
import { confirmDialogAction, createTvConfirmDialog } from "./confirm-dialog.js";

describe("confirmDialogAction", () => {
  it("moves focus between the two buttons with either direction", () => {
    // Two buttons only, so demanding the "correct" arrow to reach a visible
    // option is a papercut on a remote.
    expect(confirmDialogAction("left", true)).toEqual({ toggle: true });
    expect(confirmDialogAction("right", true)).toEqual({ toggle: true });
    expect(confirmDialogAction("left", false)).toEqual({ toggle: true });
  });

  it("answers with whatever is focused when OK is pressed", () => {
    expect(confirmDialogAction("press", true)).toEqual({ answer: true });
    expect(confirmDialogAction("press", false)).toEqual({ answer: false });
  });

  it("treats Back as no, even when Yes is focused", () => {
    // Backing out of a permission prompt must never approve it.
    expect(confirmDialogAction("back", true)).toEqual({ answer: false });
    expect(confirmDialogAction("back", false)).toEqual({ answer: false });
  });

  it("ignores up and down — there is nothing above or below", () => {
    expect(confirmDialogAction("up", true)).toBeUndefined();
    expect(confirmDialogAction("down", true)).toBeUndefined();
  });

  it("ignores keys the remote mapper didn't recognise", () => {
    // A real keyboard attached to a TV must not answer the prompt by accident.
    expect(confirmDialogAction(undefined, true)).toBeUndefined();
  });
});

describe("createTvConfirmDialog", () => {
  it("refuses to build without a DOM instead of failing later", () => {
    // The UI package has no browser environment in CI; the message has to say
    // why rather than throwing on `document` deep inside.
    expect(typeof document).toBe("undefined");
    expect(() => createTvConfirmDialog()).toThrow(/requires a DOM/);
  });
});
