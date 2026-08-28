import { describe, it, expect } from "vitest";
import { DeviceGraph, createManualSource, runDiscovery } from "@hearthkit/core";
import { createMockCecBus, MOCK_LIVING_ROOM } from "./mock.js";
import { createCecSource } from "./source.js";

describe("the CEC discovery source", () => {
  it("reports what answered the bus, with the topology behind it", async () => {
    const devices = new DeviceGraph();
    await runDiscovery(devices, [createCecSource(createMockCecBus(MOCK_LIVING_ROOM))]);

    const ps5 = devices.get("cec-2-0-0-0");
    expect(ps5?.name).toBe("PlayStation 5");
    expect(ps5?.type).toBe("game_console");
    expect(ps5?.connection).toEqual({ kind: "hdmi", port: "hdmi2" });
    expect(ps5?.vendor).toBe("Sony");
    expect(ps5?.discoveredBy).toContain("hdmi_cec");
  });

  it("puts a device behind an AVR under the AVR", async () => {
    const devices = new DeviceGraph();
    await runDiscovery(devices, [createCecSource(createMockCecBus(MOCK_LIVING_ROOM))]);

    // 3.1.0.0 is port 1 of the device at 3.0.0.0. That is the parent hop, and it
    // came out of the address rather than out of a second discovery pass.
    expect(devices.get("cec-3-1-0-0")?.parentId).toBe("cec-3-0-0-0");
    // And the walk that answers "which input shows this device" reaches HDMI3
    // through the AVR rather than stopping at a device with no port of its own.
    expect(devices.inputPortFor("cec-3-1-0-0")).toBe("hdmi3");
    expect(devices.get("cec-3-0-0-0")?.type).toBe("avr");
    // Straight into the TV: no parent, rather than the TV as a parent.
    expect(devices.get("cec-2-0-0-0")?.parentId).toBeUndefined();
  });

  it("does not claim a parent that is not on the bus", async () => {
    // A device at 3.1.0.0 with nothing at 3.0.0.0 means there is a switch or an
    // AVR in the path that does not speak CEC. That is real, and not a reason to
    // invent a node for it.
    const bus = createMockCecBus([{ logical: 8, physical: "3.1.0.0", osdName: "Apple TV" }]);
    const devices = new DeviceGraph();
    await runDiscovery(devices, [createCecSource(bus)]);

    expect(devices.get("cec-3-1-0-0")?.parentId).toBeUndefined();
    expect(devices.list()).toHaveLength(1);
  });

  it("leaves the television to the platform source", async () => {
    // The TV announces itself at 0.0.0.0. It is already the root of the graph
    // with the model name the HAL knows, so a second, weaker claim on it here
    // could only make that worse.
    const devices = new DeviceGraph();
    await runDiscovery(devices, [createCecSource(createMockCecBus(MOCK_LIVING_ROOM))]);
    expect(devices.list().map((d) => d.id)).not.toContain("cec-0-0-0-0");
  });

  it("names a device that never sent a name after where it is", async () => {
    const bus = createMockCecBus([{ logical: 4, physical: "1.0.0.0" }]);
    const devices = new DeviceGraph();
    await runDiscovery(devices, [createCecSource(bus)]);
    expect(devices.get("cec-1-0-0-0")?.name).toBe("Device on HDMI1");
  });

  it("is unavailable, not broken, on a platform with no CEC", async () => {
    const bus = createMockCecBus(MOCK_LIVING_ROOM, { absent: true });
    const source = createCecSource(bus);

    // This is the normal answer on Android without the HDMI_CEC permission, and
    // the only answer on Tizen and webOS. `runDiscovery` must not even call it.
    expect(await source.available()).toBe(false);
    const devices = new DeviceGraph();
    const result = await runDiscovery(devices, [source]);
    expect(result.failed).toHaveLength(0);
    expect(devices.list()).toHaveLength(0);
    expect(bus.sent).toEqual([]);
  });

  it("reports a failing bus as a failed source rather than an empty room", async () => {
    const bus = createMockCecBus(MOCK_LIVING_ROOM, { scanFails: true });
    const devices = new DeviceGraph();
    const result = await runDiscovery(devices, [createCecSource(bus)]);

    // "The scan broke" and "there is nothing plugged in" are different facts,
    // and a graph that silently forgets a console is worse than one that says
    // it could not look.
    expect(result.failed).toContain("hdmi_cec");
    expect(devices.list()).toHaveLength(0);
  });

  it("does not rename a device someone registered by hand", async () => {
    const devices = new DeviceGraph();
    await runDiscovery(devices, [
      createManualSource([{
        id: "cec-2-0-0-0", type: "game_console", name: "Andy's PS5",
        connection: { kind: "hdmi", port: "hdmi2" }, source: "manual",
      }]),
      // CEC arrives second with weaker evidence for the name. The graph merges
      // per field and keeps the better one; the port and the CEC address it
      // brings are new information and are kept.
      createCecSource(createMockCecBus([{ logical: 4, physical: "2.0.0.0" }])),
    ]);

    const device = devices.get("cec-2-0-0-0");
    expect(device?.name).toBe("Andy's PS5");
    expect(device?.type).toBe("game_console");
    expect(device?.discoveredBy).toEqual(expect.arrayContaining(["manual", "hdmi_cec"]));
  });
});
