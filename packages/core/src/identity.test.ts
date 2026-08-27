import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@hearthkit/platform-api";
import { createWebAdapter } from "@hearthkit/adapter-web";
import {
  loadInstallId, resetInstallId, generateInstallId, isPlausibleInstallId, INSTALL_ID_KEY,
} from "./identity.js";

/**
 * Counting installations is a legitimate thing for a service to do. Turning that
 * into tracking is one hardware identifier away, so these tests are mostly about
 * what the id is *not*.
 */

describe("install identity", () => {
  it("is stable across restarts", async () => {
    const storage = createMemoryStore();
    const first = await loadInstallId(storage);
    expect(await loadInstallId(storage)).toBe(first);
    expect(isPlausibleInstallId(first)).toBe(true);
  });

  it("is different on two identical televisions", async () => {
    // Same model, same OS, same everything — and no shared identity, because
    // nothing about the id is derived from the device.
    const a = createWebAdapter();
    const b = createWebAdapter();
    expect(a.device.model).toBe(b.device.model);

    const idA = await loadInstallId(createMemoryStore());
    const idB = await loadInstallId(createMemoryStore());
    expect(idA).not.toBe(idB);
  });

  it("contains nothing derived from the device", async () => {
    const platform = createWebAdapter();
    const id = await loadInstallId(platform.storage);
    for (const known of [platform.device.model, platform.device.os, platform.device.soc, platform.device.osVersion]) {
      if (known && known.length > 3) expect(id).not.toContain(known);
    }
    // Just a prefix and hex: no room for anything smuggled in.
    expect(id).toMatch(/^hth_[0-9a-f]{32}$/);
  });

  it("can be reset, and the old one does not come back", async () => {
    const storage = createMemoryStore();
    const before = await loadInstallId(storage);
    const after = await resetInstallId(storage);
    expect(after).not.toBe(before);
    expect(await loadInstallId(storage)).toBe(after);
  });

  it("replaces a stored value that is not one of ours", async () => {
    const storage = createMemoryStore();
    // Someone, or some earlier version, put something else here.
    await storage.set(INSTALL_ID_KEY, "androidId:9774d56d682e549c");
    const id = await loadInstallId(storage);
    expect(id).not.toContain("9774d56d682e549c");
    expect(isPlausibleInstallId(id)).toBe(true);
  });

  it("still runs when storage is unavailable, and says nothing false about it", async () => {
    const broken = {
      get: async () => { throw new Error("storage unavailable"); },
      set: async () => { throw new Error("storage unavailable"); },
      delete: async () => {},
    };
    const first = await loadInstallId(broken);
    const second = await loadInstallId(broken);
    expect(isPlausibleInstallId(first)).toBe(true);
    // Ephemeral: a device like this counts as a new install every boot, which
    // overstates the device count. Documented rather than hidden.
    expect(second).not.toBe(first);
  });

  it("does not collide across many generations", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateInstallId()));
    expect(ids.size).toBe(2000);
  });
});
