import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@hearthkit/platform-api";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { DeviceGraph, runDiscovery } from "./graph.js";
import { createPlatformSource } from "./platform-source.js";
import { createStoredSource, forgetDevice, loadDevices, registerDevice, saveDevices } from "./store.js";
import { deviceTreeText } from "./report.js";

describe("the room, remembered", () => {
  it("survives a reload", async () => {
    const storage = createMemoryStore();
    await registerDevice(storage, {
      id: "ps5", type: "game_console", name: "PlayStation 5",
      connection: { kind: "hdmi", port: "hdmi2" }, source: "manual",
    });

    // A fresh boot: nothing in memory, everything in storage.
    const graph = await loadDevices(storage);
    expect(graph.get("ps5")?.name).toBe("PlayStation 5");
    expect(graph.inputPortFor("ps5")).toBe("hdmi2");
  });

  it("forgets one on request, and leaves the rest", async () => {
    const storage = createMemoryStore();
    await registerDevice(storage, { id: "ps5", name: "PS5", connection: { kind: "hdmi", port: "hdmi2" }, source: "manual" });
    await registerDevice(storage, { id: "stb", name: "STB", connection: { kind: "hdmi", port: "hdmi3" }, source: "manual" });

    expect(await forgetDevice(storage, "ps5")).toBe(true);
    expect(await forgetDevice(storage, "ps5")).toBe(false);
    expect((await loadDevices(storage)).dump().map((d) => d.id)).toEqual(["stb"]);
  });

  it("skips a corrupt record rather than refusing to start", async () => {
    const storage = createMemoryStore();
    await storage.set("devices:graph", JSON.stringify([
      { id: "ps5", name: "PS5", connection: { kind: "hdmi", port: "hdmi2" }, capabilities: [], discoveredBy: [], confidence: 1, lastSeen: 0, type: "game_console" },
      { name: "no id" },
      "nonsense",
    ]));
    expect((await loadDevices(storage)).dump().map((d) => d.id)).toEqual(["ps5"]);
  });

  it("survives storage holding something that isn't JSON at all", async () => {
    const storage = createMemoryStore();
    await storage.set("devices:graph", "}{");
    expect((await loadDevices(storage)).dump()).toEqual([]);
  });

  it("merges what was stored with what the platform reports", async () => {
    const storage = createMemoryStore();
    await registerDevice(storage, {
      id: "ps5", type: "game_console", name: "PlayStation 5",
      connection: { kind: "hdmi", port: "hdmi2" }, source: "manual",
    });
    const platform = createWebAdapter();
    await platform.system.setInputSource("hdmi2");

    const graph = new DeviceGraph();
    await runDiscovery(graph, [createStoredSource(storage), createPlatformSource(platform)]);

    // The platform can only say "something is on HDMI2". It must merge into the
    // PS5 we were told about, not appear beside it as a second device.
    expect(graph.dump().map((d) => d.id).sort()).toEqual(["ps5", "tv"]);
    expect(graph.get("ps5")?.discoveredBy.sort()).toEqual(["manual", "platform"]);
    expect(graph.get("ps5")?.name).toBe("PlayStation 5");
  });

  it("names the port it can see without inventing what is on it", async () => {
    const platform = createWebAdapter();
    await platform.system.setInputSource("hdmi3");
    const graph = new DeviceGraph();
    await runDiscovery(graph, [createPlatformSource(platform)]);

    const found = graph.dump().find((d) => d.connection.kind === "hdmi")!;
    expect(found.type).toBe("unknown");
    expect(found.confidence).toBeLessThan(0.5);
  });

  it("prints the room with its uncertainty visible", async () => {
    const storage = createMemoryStore();
    await registerDevice(storage, { id: "ps5", name: "PS5", type: "game_console", connection: { kind: "hdmi", port: "hdmi2" }, source: "manual" });
    const text = deviceTreeText(await loadDevices(storage));
    expect(text).toContain("PS5 [ps5] — HDMI2 · 100% · manual");
  });

  it("says so plainly when it knows nothing", () => {
    expect(deviceTreeText(new DeviceGraph())).toMatch(/No devices known/);
  });

  it("round-trips a graph through storage", async () => {
    const storage = createMemoryStore();
    const graph = new DeviceGraph();
    graph.observe({ id: "avr", name: "AVR", type: "avr", connection: { kind: "hdmi", port: "hdmi1" }, source: "manual" });
    graph.observe({ id: "apple-tv", name: "Apple TV", type: "streaming_stick", parentId: "avr", connection: { kind: "network", ip: "10.0.0.5" }, source: "mdns" });
    await saveDevices(storage, graph);

    const restored = await loadDevices(storage);
    // The parent hop is the whole reason this is a graph and not a list.
    expect(restored.inputPortFor("apple-tv")).toBe("hdmi1");
  });
});
