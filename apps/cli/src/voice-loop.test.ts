import { describe, it, expect } from "vitest";
import { Agent } from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { createScriptedClient } from "@hearthkit/llm-connectors";
import type { VoicePipeline } from "@hearthkit/platform-api";
import type { RingState, StatusRing } from "@hearthkit/adapter-linux";
import { answer, listenForever, showOutcomes } from "./voice-loop.js";

/**
 * The living room, before the living room.
 *
 * A microphone that "hears" a script, a ring that records what it was asked to
 * show, the real agent on the in-memory television. What this proves is the
 * chain between them — attention word → plan → read-back → ring → spoken
 * reply — which is the part a real microphone cannot help debug, because by
 * the time it is involved there are four other things that could be wrong.
 */
function scriptedMicrophone(utterances: string[]) {
  const listeners = new Set<(text: string, isFinal: boolean) => void>();
  const spoken: string[] = [];
  let i = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });
  const voice: VoicePipeline = {
    startListening: async () => {
      // Each attempt is one five-second window: one line of the script, final.
      const text = utterances[i++];
      if (text === undefined) { resolveDone(); await new Promise(() => {}); }   // out of script: hang like a quiet room
      await Promise.resolve();
      for (const cb of listeners) cb(text!, true);
    },
    stopListening: async () => {},
    onTranscript: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onListeningEnd: () => () => {},
    speak: async (text) => { spoken.push(text); },
  };
  return { voice, spoken, done };
}

function recordingRing() {
  const states: RingState[] = [];
  const ring: StatusRing = {
    show: async (state) => { states.push(state); },
    off: async () => { states.push("off"); },
  };
  return { ring, states };
}

async function livingRoom() {
  const platform = createWebAdapter();
  await platform.init();
  await platform.system.setVolume(40);
  const agent = new Agent({ platform, llm: createScriptedClient(), confirm: async () => true });
  await agent.probeCapabilities();
  return { platform, agent };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("answer()", () => {
  it("plans what it can plan, and the ring sees every step", async () => {
    const { platform, agent } = await livingRoom();
    const { ring, states } = recordingRing();
    showOutcomes(agent, ring);

    const reply = await answer(agent, "turn it down");
    expect(await platform.system.getVolume()).toBeLessThan(40);
    expect(reply).toMatch(/^Done: tv\.audio\.set_volume/);
    // Verified, because the in-memory TV reads back what was set. This is
    // the line a plain agent.run() never produced.
    expect(states).toEqual(["verified"]);
  });

  it("falls back to conversation for what is not a goal", async () => {
    const { agent } = await livingRoom();
    const reply = await answer(agent, "what's the volume?");
    expect(reply).toMatch(/40/);
  });
});

describe("the voice loop, with a scripted microphone", () => {
  it("acts only on what follows the attention word, lights the ring, and speaks the reply", async () => {
    const { platform, agent } = await livingRoom();
    const { ring, states } = recordingRing();
    const { voice, spoken, done } = scriptedMicrophone([
      "could you pass the salt",
      "Hearth, turn it down.",
      "hearth",
    ]);
    showOutcomes(agent, ring);
    const trace: string[] = [];

    const outputs: string[] = [];
    const handle = async (command: string) => {
      await ring.show("thinking");
      const output = await answer(agent, command);
      outputs.push(output);
      await voice.speak(output);
    };
    const loop = listenForever(voice, handle, { ring, wakeWord: "hearth", trace: (l) => trace.push(l) });
    await done;
    await settle();
    await loop.stop();

    expect(trace).toEqual([
      "  🎤 (not for me) could you pass the salt",
      "  🎤 Hearth, turn it down.",
      "  🎤 hearth",
    ]);
    expect(outputs).toEqual([expect.stringMatching(/^Done: tv\.audio\.set_volume/)]);
    expect(await platform.system.getVolume()).toBeLessThan(40);
    // The reply, then "Yes?" for the bare word — nothing for the salt.
    expect(spoken).toEqual([expect.stringMatching(/^Done:/), "Yes?"]);
    // Listening between every window, thinking while planning, verified when
    // the read-back agreed. Never anything for the utterance that was not ours.
    expect(states.filter((s) => s !== "listening")).toEqual(["thinking", "verified"]);
    expect(states[0]).toBe("listening");
  });

  it("with no attention word, acts on everything", async () => {
    const { agent } = await livingRoom();
    const { voice, done } = scriptedMicrophone(["turn it down"]);
    const outputs: string[] = [];
    const loop = listenForever(voice, async (c) => { outputs.push(await answer(agent, c)); }, {});
    await done; await settle(); await loop.stop();
    expect(outputs).toHaveLength(1);
  });

  it("stops listening, and says so once, when the microphone cannot be opened", async () => {
    const trace: string[] = [];
    const voice: VoicePipeline = {
      startListening: async () => { throw new Error("arecord could not capture from \"default\""); },
      stopListening: async () => {},
      onTranscript: () => () => {},
      onListeningEnd: () => () => {},
      speak: async () => {},
    };
    const loop = listenForever(voice, async () => {}, { trace: (l) => trace.push(l) });
    await settle();
    await loop.stop();
    expect(trace).toEqual([expect.stringMatching(/^hearth: listening stopped — arecord could not capture/)]);
  });
});
