import { describe, it, expect } from "vitest";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { createCecTransport, createMockCecBus, MOCK_LIVING_ROOM } from "@hearthkit/adapter-cec";
import { parseArgs } from "./args.js";
import { assembleRoom } from "./room.js";
import { runReport } from "./report.js";

/**
 * The report, end to end, against the in-memory TV and a mock CEC bus.
 *
 * The mock bus is the point: a Pi beside a television is the first host that
 * sees a console *from outside*, and "play ps5" going from `out of reach` to
 * `verified` when a bus appears is the whole reason `hearth report` exists.
 */
async function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (t: string) => { out.push(t); }, err: (t: string) => { err.push(t); } } };
}

describe("assembleRoom", () => {
  it("gives the mock platform no transports, and says nothing about a bus", async () => {
    const platform = createWebAdapter();
    await platform.init();
    const room = await assembleRoom(parseArgs(["--room", "demo"]), platform, { persist: false });
    expect(room.capabilities).toEqual([]);
    expect(room.notes).toEqual([]);
    expect(room.tree.join("\n")).toMatch(/PlayStation 5 \[ps5\]/);
  });

  it("attaches CEC capabilities under the name the room already uses", async () => {
    const platform = createWebAdapter();
    await platform.init();
    const room = await assembleRoom(parseArgs(["--room", "demo"]), platform, {
      persist: false,
      transports: async () => [createCecTransport(createMockCecBus(MOCK_LIVING_ROOM))],
    });
    expect(room.capabilities.map((c) => c.id)).toContain("ps5.power.on");
    expect(room.notes[0]).toMatch(/device\(s\) reachable: .*ps5/);
  });
});

describe("hearth report", () => {
  it("prints one markdown section and nothing else on stdout", async () => {
    const platform = createWebAdapter();
    await platform.init();
    const { out, err, sink } = await io();
    const code = await runReport(parseArgs(["report", "--room", "demo", "--yes"]), platform, sink);

    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const md = out[0]!;
    expect(md.startsWith("## ")).toBe(true);
    expect(md).toContain("**Capability probe**:");
    expect(md).toContain("### Did anything accept a command and then do nothing?");
    // Without a bus the console is out of reach, and the report must say so
    // rather than invent a result.
    expect(md).toMatch(/“play ps5”[\s\S]*out of reach: devices\.ps5\.power/);
    expect(md).toContain("gated steps were approved automatically");
    expect(err.join("")).toMatch(/Paste it into an issue/);
  });

  it("reports a woken console as verified once a CEC bus is in the room", async () => {
    const platform = createWebAdapter();
    await platform.init();
    const { out, sink } = await io();
    // The room assembly is what the test substitutes, through the same seam the
    // CLI uses; `runReport` itself takes the platform and asks for the room.
    const opts = parseArgs(["report", "--room", "demo", "--yes", "--intents", "play ps5"]);
    const code = await runReport(opts, platform, sink, {
      transports: async () => [createCecTransport(createMockCecBus(MOCK_LIVING_ROOM))],
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/`ps5\.power\.on\(\)` — \*\*verified\*\*/);
    expect(out[0]).toMatch(/`tv\.input\.switch\(source=hdmi2\)` — \*\*verified\*\*/);
  });

  it("declines gated steps without --yes and says so, instead of hanging or pretending", async () => {
    const platform = createWebAdapter();
    await platform.init();
    const { out, sink } = await io();
    const opts = parseArgs(["report", "--room", "demo", "--intents", "switch to hdmi2"]);
    await runReport(opts, platform, sink);
    expect(out[0]).toContain("gated steps were declined");
  });

  it("emits the structured report with --json", async () => {
    const platform = createWebAdapter();
    await platform.init();
    const { out, sink } = await io();
    await runReport(parseArgs(["report", "--json", "--room", "empty", "--intents", "turn it down"]), platform, sink);
    const report = JSON.parse(out[0]!);
    expect(report.device.os).toBe("web");
    expect(report.intents).toHaveLength(1);
    expect(Array.isArray(report.notes)).toBe(true);
  });
});
