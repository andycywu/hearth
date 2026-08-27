import { describe, it, expect } from "vitest";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { Agent } from "../agent/agent.js";
import { DeviceGraph } from "../devices/graph.js";
import { collectDeviceReport, deviceReportToMarkdown } from "./device-report.js";
import type { LlmClient, CompletionResult } from "../llm/client.js";

/**
 * The report is a contribution artefact, so what it must never do is quietly
 * flatter the device: a step nothing could confirm has to read `unverified`, and
 * a step that was accepted and ignored has to be findable without reading the
 * whole page.
 */

const silent: LlmClient = {
  id: "silent",
  complete: async (): Promise<CompletionResult> => ({
    wantsToolCalls: false,
    message: { role: "assistant", content: "ok" },
  }),
};

function agentWithRoom() {
  const devices = new DeviceGraph();
  devices.observe({
    id: "ps5", name: "PlayStation 5", type: "game_console",
    connection: { kind: "hdmi", port: "hdmi2" }, source: "manual", confidence: 1,
  });
  const platform = createWebAdapter();
  const agent = new Agent({ platform, llm: silent, devices, confirm: () => true });
  return { agent, platform };
}

describe("device report", () => {
  it("collects the probe, the plans and the room in one pass", async () => {
    const { agent, platform } = agentWithRoom();
    const report = await collectDeviceReport({
      agent, platform,
      intents: ["switch to hdmi2", "play ps5"],
      now: () => new Date("2026-08-18T10:00:00Z"),
    });

    expect(report.device.os).toBe("web");
    expect(report.diagnostics.summary.ok).toBeGreaterThan(0);
    expect(report.intents.map((i) => i.goal)).toEqual(["input_switched", "gaming_session_active"]);
    expect(report.intents[0]?.outcomes[0]).toMatchObject({
      capability: "tv.input.switch", status: "verified",
    });
    expect(report.room).toContain("PlayStation 5");
  });

  it("records an utterance that was not plan work, rather than dropping it", async () => {
    const { agent, platform } = agentWithRoom();
    const report = await collectDeviceReport({ agent, platform, intents: ["what's on tonight?"] });
    expect(report.intents[0]).toMatchObject({ conversational: true });
    // "It planned nothing" and "it never planned" are different findings, and a
    // reader comparing two devices needs to tell them apart.
    expect(deviceReportToMarkdown(report)).toContain("handled as conversation");
  });

  it("surfaces accept-and-do-nothing as its own section", async () => {
    const { agent, platform } = agentWithRoom();
    // A TV that takes the write and stays where it was — the failure mode no
    // adapter reports about itself.
    platform.system.setInputSource = async () => {};
    const report = await collectDeviceReport({ agent, platform, intents: ["switch to hdmi2"] });

    expect(report.acceptedButDidNothing).toHaveLength(1);
    expect(report.acceptedButDidNothing[0]?.capability).toBe("tv.input.switch");
    const md = deviceReportToMarkdown(report);
    expect(md).toContain("**Yes** — these were accepted and the read-back disagreed");
    expect(md).toContain("no adapter can report it about itself");
  });

  it("says plainly when nothing was caught, without claiming the device is clean", async () => {
    const { agent, platform } = agentWithRoom();
    const report = await collectDeviceReport({ agent, platform, intents: ["switch to hdmi2"] });
    expect(report.acceptedButDidNothing).toEqual([]);
    const md = deviceReportToMarkdown(report);
    expect(md).toContain("Nothing detected in this run");
    // The caveat matters: only a verifiable action can answer the question.
    expect(md).toContain("Only actions with a read-back can answer this");
  });

  it("lists what the device withdrew, with the reason", async () => {
    const { agent, platform } = agentWithRoom();
    agent.capabilities.withdraw("tv.audio.set_volume", "no audio control API on this build");
    const md = deviceReportToMarkdown(await collectDeviceReport({ agent, platform, intents: [] }));
    expect(md).toContain("Withdrawn on this device");
    expect(md).toContain("no audio control API on this build");
  });

  it("produces markdown that needs no editing before pasting", async () => {
    const { agent, platform } = agentWithRoom();
    const md = deviceReportToMarkdown(await collectDeviceReport({
      agent, platform,
      intents: ["turn it down"],
      notes: ["ran with ?plan&room=demo"],
      now: () => new Date("2026-08-18T10:00:00Z"),
    }));

    expect(md.startsWith("## dev-browser — web ")).toBe(true);
    expect(md).toContain("(reported 2026-08-18)");
    expect(md).toContain("| Capability | Status | Detail |");
    expect(md).toContain("### Goal mode");
    expect(md).toContain("### The room");
    expect(md).toContain("- ran with ?plan&room=demo");
  });
});
