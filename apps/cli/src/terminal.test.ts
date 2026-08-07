import { describe, it, expect } from "vitest";
import { readlineOptions, stripBom } from "./terminal.js";

describe("readlineOptions", () => {
  it("gives readline somewhere to draw, so typing is visible", () => {
    // The actual bug this pins: without an `output` stream, readline in terminal
    // mode reads the keys and echoes nothing — you type blind, with no backspace
    // and no arrow keys. It looked fine in every non-interactive test.
    const opts = readlineOptions(true);
    expect(opts.output, "no output stream means no echo").toBeDefined();
    expect(opts.terminal).toBe(true);
  });

  it("echoes to stderr, so a pipe still gets only the answer", () => {
    // stdout carries the reply; the prompt and the user's keystrokes must not
    // end up in `tv-agent … | something`.
    expect(readlineOptions(true).output).toBe(process.stderr);
  });

  it("writes nothing at all when stdin is a pipe", () => {
    const opts = readlineOptions(false);
    expect(opts.output).toBeUndefined();
    expect(opts.terminal).toBe(false);
  });

  it("carries a prompt for readline to redraw", () => {
    expect(readlineOptions(true).prompt).toBe("> ");
  });
});

describe("stripBom", () => {
  it("removes a byte-order mark that would become part of the command", () => {
    expect(stripBom("﻿mute")).toBe("mute");
  });

  it("leaves an ordinary line alone", () => {
    expect(stripBom("mute")).toBe("mute");
    expect(stripBom("把音量調到 30")).toBe("把音量調到 30");
  });
});
