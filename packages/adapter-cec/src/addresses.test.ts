import { describe, it, expect } from "vitest";
import {
  connectionFor, deviceIdFor, deviceTypeFor, fallbackName, parentPhysical, parsePhysical,
} from "./addresses.js";

describe("physical addresses", () => {
  it("reads the TV's port from the first nibble, and only the first", () => {
    expect(connectionFor({ logical: 4, physical: "2.0.0.0" })).toEqual({ kind: "hdmi", port: "hdmi2" });
    // Behind an AVR on HDMI3 — it is still reached through HDMI3, which is the
    // port the TV would have to select.
    expect(connectionFor({ logical: 8, physical: "3.1.0.0" })).toEqual({ kind: "hdmi", port: "hdmi3" });
  });

  it("calls 0.0.0.0 internal, because that is the television itself", () => {
    expect(connectionFor({ logical: 0, physical: "0.0.0.0" })).toEqual({ kind: "internal" });
  });

  it("refuses to invent a port it has no type for", () => {
    // A fifth HDMI port is not impossible; `Connection` covers four. Saying
    // "unknown" beats claiming hdmi1.
    expect(connectionFor({ logical: 4, physical: "5.0.0.0" })).toEqual({ kind: "unknown" });
    expect(connectionFor({ logical: 4 })).toEqual({ kind: "unknown" });
    expect(connectionFor({ logical: 4, physical: "2.0.0" })).toEqual({ kind: "unknown" });
    expect(connectionFor({ logical: 4, physical: "2.0.0.99" })).toEqual({ kind: "unknown" });
  });

  it("parses four nibbles and rejects anything else", () => {
    expect(parsePhysical("3.1.0.0")).toEqual([3, 1, 0, 0]);
    expect(parsePhysical("1.2.3.4.5")).toBeUndefined();
    expect(parsePhysical("a.b.c.d")).toBeUndefined();
    expect(parsePhysical(undefined)).toBeUndefined();
  });

  it("derives the parent by clearing the last non-zero nibble", () => {
    expect(parentPhysical("3.1.0.0")).toBe("3.0.0.0");
    expect(parentPhysical("3.1.2.0")).toBe("3.1.0.0");
    // Straight into the TV, and the TV itself: no parent, not a bad parent.
    expect(parentPhysical("2.0.0.0")).toBeUndefined();
    expect(parentPhysical("0.0.0.0")).toBeUndefined();
  });

  it("identifies a device by where it is plugged in, not by its logical address", () => {
    // Logical addresses are reallocated when devices come and go; a console that
    // is address 4 today can be 8 tomorrow. The physical address only changes
    // when someone moves a cable, and then it *should* be a different node.
    expect(deviceIdFor({ logical: 4, physical: "2.0.0.0" })).toBe("cec-2-0-0-0");
    expect(deviceIdFor({ logical: 8, physical: "2.0.0.0" })).toBe("cec-2-0-0-0");
    expect(deviceIdFor({ logical: 4 })).toBe("cec-l4");
  });
});

describe("device type", () => {
  it("trusts a name that is decisive", () => {
    expect(deviceTypeFor({ logical: 4, osdName: "PlayStation 5" })).toBe("game_console");
    expect(deviceTypeFor({ logical: 8, osdName: "Apple TV" })).toBe("streaming_stick");
    expect(deviceTypeFor({ logical: 5, osdName: "Sonos Soundbar" })).toBe("soundbar");
  });

  it("uses the logical address only where the spec is unambiguous", () => {
    expect(deviceTypeFor({ logical: 0 })).toBe("tv");
    expect(deviceTypeFor({ logical: 5 })).toBe("avr");
    expect(deviceTypeFor({ logical: 3 })).toBe("stb");
  });

  it("leaves a playback device unknown rather than guessing", () => {
    // 4, 8 and 11 are the playback slots. A console, a Blu-ray player and a
    // streaming stick all take one, and which they get depends on who plugged in
    // first. Naming it would be inventing a device.
    for (const logical of [4, 8, 11]) {
      expect(deviceTypeFor({ logical })).toBe("unknown");
    }
  });

  it("names an unnamed device after where it is", () => {
    expect(fallbackName({ logical: 4, physical: "2.0.0.0" }, "unknown")).toBe("Device on HDMI2");
    expect(fallbackName({ logical: 5, physical: "3.0.0.0" }, "avr")).toBe("avr on HDMI3");
    expect(fallbackName({ logical: 4 }, "unknown")).toBe("Device on CEC 4");
  });
});
