import { describe, it, expect, afterEach } from "vitest";
import { EventBus, type AgentEvents } from "@tv-ai-agent/core";
import type { Agent, ConfirmRequest } from "@tv-ai-agent/core";
import type { PlatformProvider, VoicePipeline } from "@tv-ai-agent/platform-api";
import {
  createConfirmHandler, confirmOverrideFromUrl, commandsFromUrl, speakReplies, keyboardOption,
  renderOption, inviteText, debugRequested, confirmQuestion,
} from "./device-ux.js";

const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  name: "set_input_source",
  args: { source: "hdmi2" },
  description: "Switch the active input source.",
  ...over,
});

function fakeAgent(): { agent: Agent; events: EventBus<AgentEvents> } {
  const events = new EventBus<AgentEvents>();
  return { agent: { events } as unknown as Agent, events };
}

/** A platform whose voice slot may be missing, like a device without TTS. */
function platformWithVoice(voice?: Partial<VoicePipeline>): PlatformProvider {
  const provider = {
    voice: voice as VoicePipeline | undefined,
    has: (cap: string) => cap in provider && (provider as any)[cap] !== undefined,
  };
  return provider as unknown as PlatformProvider;
}

describe("createConfirmHandler", () => {
  it("asks the supplied prompt and returns the answer", async () => {
    const asked: string[] = [];
    const allow = createConfirmHandler({ ask: (q) => { asked.push(q); return true; } });
    expect(await allow(request())).toBe(true);
    expect(asked).toEqual(["Switch the TV input to HDMI 2?"]);

    const deny = createConfirmHandler({ ask: () => false });
    expect(await deny(request())).toBe(false);
  });

  it("awaits an async dialog", async () => {
    const handler = createConfirmHandler({ ask: async () => true });
    await expect(Promise.resolve(handler(request()))).resolves.toBe(true);
  });

  it("still surfaces an argument the plain-words question doesn't name", async () => {
    // The rewrite to plain words must not narrow what is being approved: this is
    // the one dialog with side effects behind it, so an argument the viewer
    // can't see is an argument they never agreed to.
    let question = "";
    const handler = createConfirmHandler({ ask: (q) => { question = q; return true; } });
    await handler(request({ name: "launch_app", args: { appId: "netflix", cold: true } }));
    expect(question).toBe("Open Netflix? (cold: true)");
  });

  it("approves by default when no dialog is available", async () => {
    // Node/CI and engines that stub out window.confirm: a turn must not stall on
    // a dialog nobody can see.
    expect(typeof window).toBe("undefined");
    expect(await createConfirmHandler()(request())).toBe(true);
  });

  it("can be configured to deny instead", async () => {
    expect(await createConfirmHandler({ fallback: false })(request())).toBe(false);
  });

  it("uses window.confirm when the engine provides one", async () => {
    const seen: string[] = [];
    (globalThis as any).window = { confirm: (q: string) => { seen.push(q); return false; } };
    try {
      expect(await createConfirmHandler()(request())).toBe(false);
      expect(seen).toHaveLength(1);
    } finally {
      delete (globalThis as any).window;
    }
  });
});

describe("confirmOverrideFromUrl", () => {
  it("stays out of the way unless the flag is present", () => {
    expect(confirmOverrideFromUrl("")).toBeUndefined();
    expect(confirmOverrideFromUrl("?diag&llm=http://x/v1")).toBeUndefined();
  });

  it("auto-approves with ?confirm=auto so an automated device run can proceed", async () => {
    const handler = confirmOverrideFromUrl("?confirm=auto&llm=http://x/v1");
    expect(await handler!(request())).toBe(true);
  });

  it("auto-declines with ?confirm=deny", async () => {
    expect(await confirmOverrideFromUrl("?confirm=deny")!(request())).toBe(false);
  });

  it("ignores an unrecognised value rather than guessing", () => {
    // Falling back to the real handler is the safe reading of ?confirm=yes.
    expect(confirmOverrideFromUrl("?confirm=yes")).toBeUndefined();
    expect(confirmOverrideFromUrl("?confirm=")).toBeUndefined();
  });
});

describe("commandsFromUrl", () => {
  it("returns nothing when no ?ask= is present", () => {
    expect(commandsFromUrl("")).toEqual([]);
    expect(commandsFromUrl("?diag&llm=http://x/v1")).toEqual([]);
  });

  it("reads a single command, url-decoded", () => {
    expect(commandsFromUrl("?ask=set%20volume%20to%2030")).toEqual(["set volume to 30"]);
  });

  it("reads several in order, so a launch can drive a whole demo", () => {
    expect(commandsFromUrl("?ask=mute&llm=http://x/v1&ask=open+Netflix"))
      .toEqual(["mute", "open Netflix"]);
  });

  it("drops blank entries rather than running an empty turn", () => {
    expect(commandsFromUrl("?ask=&ask=%20%20&ask=mute")).toEqual(["mute"]);
  });

  it("handles non-Latin commands", () => {
    expect(commandsFromUrl("?ask=" + encodeURIComponent("音量調到 30")))
      .toEqual(["音量調到 30"]);
  });
});

describe("speakReplies", () => {
  afterEach(() => { delete (globalThis as any).window; });

  it("speaks the final output of every turn", () => {
    const spoken: string[] = [];
    const { agent, events } = fakeAgent();
    speakReplies(agent, platformWithVoice({ speak: async (t) => { spoken.push(t); } }));
    events.emit("turn:end", { output: "Volume set to 30." });
    events.emit("turn:end", { output: "音量已設為 30。" });
    expect(spoken).toEqual(["Volume set to 30.", "音量已設為 30。"]);
  });

  it("does nothing on a device without voice", () => {
    const { agent, events } = fakeAgent();
    const off = speakReplies(agent, platformWithVoice(undefined));
    expect(() => { events.emit("turn:end", { output: "hi" }); off(); }).not.toThrow();
  });

  it("stops speaking once unsubscribed", () => {
    const spoken: string[] = [];
    const { agent, events } = fakeAgent();
    const off = speakReplies(agent, platformWithVoice({ speak: async (t) => { spoken.push(t); } }));
    events.emit("turn:end", { output: "first" });
    off();
    events.emit("turn:end", { output: "second" });
    expect(spoken).toEqual(["first"]);
  });

  it("swallows a TTS failure so it can't break the turn", () => {
    const { agent, events } = fakeAgent();
    speakReplies(agent, platformWithVoice({ speak: async () => { throw new Error("no tts engine"); } }));
    expect(() => events.emit("turn:end", { output: "hi" })).not.toThrow();
  });

  it("survives an engine whose speak throws synchronously", () => {
    const { agent, events } = fakeAgent();
    const voice = { speak: (() => { throw new Error("boom"); }) as unknown as VoicePipeline["speak"] };
    speakReplies(agent, platformWithVoice(voice));
    expect(() => events.emit("turn:end", { output: "hi" })).not.toThrow();
  });
});

describe("keyboardOption", () => {
  it("is absent when the flag isn't there, so bring-up keeps the screen", () => {
    expect(keyboardOption("?demo")).toEqual({});
  });

  it("turns the keyboard on for a bare flag", () => {
    expect(keyboardOption("?keyboard")).toEqual({ keyboard: true });
    expect(keyboardOption("?demo&keyboard&confirm=auto")).toEqual({ keyboard: true });
  });

  it("opens on a named layout when one is given", () => {
    // A build for viewers who mostly speak Chinese starts on phrases, since
    // characters can't be typed from a grid.
    expect(keyboardOption("?keyboard=phrases")).toEqual({ keyboard: "phrases" });
    expect(keyboardOption("?keyboard=kana&demo")).toEqual({ keyboard: "kana" });
  });

  it("decodes a percent-encoded layout name", () => {
    expect(keyboardOption("?keyboard=%70hrases")).toEqual({ keyboard: "phrases" });
  });

  it("treats an empty value as just on", () => {
    expect(keyboardOption("?keyboard=")).toEqual({ keyboard: true });
  });

  it("doesn't match a different flag that starts the same way", () => {
    expect(keyboardOption("?keyboardless")).toEqual({});
    expect(keyboardOption("?render=avatar&keyboards")).toEqual({});
  });
});

describe("renderOption", () => {
  it("gives a viewer the avatar by default", () => {
    // The default used to be the unstyled bring-up overlay, which is what made
    // a freshly installed app look like a test harness.
    expect(renderOption("")).toEqual({ render: "avatar" });
    expect(renderOption("?keyboard")).toEqual({ render: "avatar" });
  });

  it("still lets bring-up ask for the plain view", () => {
    expect(renderOption("?render=overlay")).toEqual({ render: "overlay" });
    expect(renderOption("?demo&render=overlay")).toEqual({ render: "overlay" });
  });

  it("keeps working for anyone who kept the old ?render=avatar in a script", () => {
    expect(renderOption("?render=avatar")).toEqual({ render: "avatar" });
  });
});

describe("debugRequested", () => {
  it("keeps the engineering line off unless asked for", () => {
    expect(debugRequested("")).toBe(false);
    expect(debugRequested("?keyboard&demo")).toBe(false);
  });

  it("shows it on ?debug", () => {
    expect(debugRequested("?debug")).toBe(true);
    expect(debugRequested("?render=avatar&debug")).toBe(true);
  });

  it("isn't switched on by a flag that merely starts with 'debug'", () => {
    expect(debugRequested("?debugger")).toBe(false);
  });
});

describe("inviteText", () => {
  it("points at the on-screen button, not a key the remote may not have", () => {
    // This used to read "Press the voice button on your remote", which is untrue
    // on a remote without that key and on an emulator with no remote at all —
    // and there was nothing else to press, so the app was unusable rather than
    // just mislabelled. OK covers a D-pad, an emulator's Enter and a click.
    expect(inviteText(false, true)).toBe("Press OK to speak");
    expect(inviteText(false, true)).not.toMatch(/remote/i);
  });

  it("offers both when both exist", () => {
    const text = inviteText(true, true);
    expect(text).toMatch(/speak/i);
    expect(text).toMatch(/type/i);
  });

  it("explains the keys when there is no microphone", () => {
    expect(inviteText(true, false)).toMatch(/arrow keys/i);
  });

  it("falls back to the bring-up instructions only when nothing else is possible", () => {
    // The only case where telling a viewer about a URL flag is the honest
    // answer: there is genuinely nothing they can do with the remote.
    expect(inviteText(false, false)).toContain("?ask=");
  });

  it("never mentions a URL flag when the viewer has a way in", () => {
    for (const [k, v] of [[true, true], [true, false], [false, true]] as const) {
      expect(inviteText(k, v)).not.toContain("?");
    }
  });
});

describe("confirmQuestion", () => {
  const req = (name: string, args: Record<string, unknown>, description = "") =>
    ({ name, args, description });

  it("asks about switching input in words, not as a call", () => {
    // `Allow set_input_source(source=hdmi1)?` asks a viewer to approve a
    // function signature, and the safe answer to a question you don't
    // understand is always No.
    expect(confirmQuestion(req("set_input_source", { source: "hdmi1" })))
      .toBe("Switch the TV input to HDMI 1?");
  });

  it("names the app rather than its reverse-DNS id", () => {
    expect(confirmQuestion(req("launch_app", { appId: "com.netflix.ninja" })))
      .toBe("Open Ninja?");
    expect(confirmQuestion(req("launch_app", { appId: "youtube_tv" })))
      .toBe("Open Youtube tv?");
  });

  it("falls back to the tool's own description for a tool it has never seen", () => {
    // Skill manifests add gated tools this file can't know about; their
    // description is already prose. Its arguments are appended, because nothing
    // here knows which of them the sentence already accounts for.
    expect(confirmQuestion(req("dim_lights", { room: "lounge" }, "Dim the lounge lights.")))
      .toBe("Dim the lounge lights? (room: lounge)");
    expect(confirmQuestion(req("sleep_now", {}, "Put the TV to sleep.")))
      .toBe("Put the TV to sleep?");
  });

  it("doesn't produce a full stop followed by a question mark", () => {
    expect(confirmQuestion(req("x", {}, "Do the thing."))).not.toContain(".?");
  });

  it("falls back to the raw call only when there is nothing else to say", () => {
    expect(confirmQuestion(req("mystery_tool", { a: 1 })))
      .toBe("Allow mystery_tool(a=1)?");
  });

  it("gives the raw call back under ?debug, arguments and all", () => {
    // This is what you want when checking that the right arguments reached the
    // gate — which is why it stays reachable rather than being deleted.
    expect(confirmQuestion(req("set_input_source", { source: "hdmi1" }), true))
      .toBe("Allow set_input_source(source=hdmi1)?");
  });
});
