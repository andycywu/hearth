/**
 * Adapter contract checker.
 *
 * A single behavioural spec every PlatformProvider must satisfy. Each adapter's
 * test suite calls `assertProviderContract(factory)` so that Tizen, AOSP and
 * web adapters are guaranteed to behave identically for the capabilities they
 * advertise — this is what keeps agent behaviour consistent across MTK/NVT and
 * AOSP/Tizen. Dependency-free (no test framework import) so it can live in the
 * runtime package without pulling vitest into device bundles.
 */
import type { PlatformProvider } from "./index.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[provider-contract] ${msg}`);
}

export interface ContractOptions {
  /** Skip mutating checks that a real device may not permit (e.g. standby). */
  skipDestructive?: boolean;
}

/**
 * Runs the contract against a freshly created provider. Throws an Error on the
 * first violation; resolves cleanly when the provider conforms.
 */
export async function assertProviderContract(
  factory: () => PlatformProvider,
  opts: ContractOptions = {},
): Promise<void> {
  const p = factory();

  // --- structure ---
  assert(p.device && typeof p.device.os === "string", "device.os must be a string");
  assert(["aosp", "tizen", "webos", "web", "linux"].includes(p.device.os), `unexpected os: ${p.device.os}`);
  assert(typeof p.device.soc === "string", "device.soc must be a string");
  assert(typeof p.init === "function", "init() must exist");
  assert(typeof p.has === "function", "has() must exist");

  await p.init(); // must be idempotent-safe to call at startup

  // --- capability probe ---
  assert(p.has("system") === true, "system control is mandatory");
  assert(p.has("apps") === true, "app control is mandatory");
  assert(p.has("navigation") === true, "navigation is mandatory");
  assert(p.has("storage") === true, "storage is mandatory");

  // --- volume round-trips within 0..100 and clamps ---
  await p.system.setVolume(30);
  const v = await p.system.getVolume();
  assert(v >= 0 && v <= 100, `volume out of range: ${v}`);
  await p.system.setVolume(999);
  const vHigh = await p.system.getVolume();
  assert(vHigh <= 100, `volume not clamped at 100: ${vHigh}`);
  await p.system.setVolume(-50);
  const vLow = await p.system.getVolume();
  assert(vLow >= 0, `volume not clamped at 0: ${vLow}`);

  // --- mute round-trips ---
  await p.system.setMute(true);
  assert((await p.system.getMute()) === true, "mute did not report true");
  await p.system.setMute(false);
  assert((await p.system.getMute()) === false, "unmute did not report false");

  // --- apps: list + name lookup ---
  const apps = await p.apps.listInstalledApps();
  assert(Array.isArray(apps), "listInstalledApps must return an array");
  for (const a of apps) {
    assert(typeof a.id === "string" && a.id.length > 0, "app.id must be a non-empty string");
    assert(typeof a.name === "string", "app.name must be a string");
  }
  const found = await p.apps.findAppsByName("");
  assert(Array.isArray(found) && found.length === 0, "empty query must return no matches");

  // --- storage round-trip ---
  await p.storage.set("contract.key", "value-1");
  assert((await p.storage.get("contract.key")) === "value-1", "storage get/set mismatch");
  await p.storage.delete("contract.key");
  assert((await p.storage.get("contract.key")) === null, "storage delete did not clear key");

  // --- network shape ---
  const online = await p.network.isOnline();
  assert(typeof online === "boolean", "isOnline must return a boolean");
  const conn = await p.network.connectionType();
  assert(["wifi", "ethernet", "none"].includes(conn), `bad connectionType: ${conn}`);

  // --- navigation, if this device can do it at all ---
  //
  // `isAvailable()` exists because some platforms genuinely can't inject keys:
  // AOSP needs an accessibility service the user has to switch on, and a Linux
  // box needs a display server and uinput access that a given image may not
  // have. This used to call `sendKey` unconditionally, which contradicted the
  // interface it was checking — a provider that answered "no" was still required
  // to succeed.
  //
  // A provider that says no must then *say so when asked*, rather than accepting
  // the key and doing nothing: silently swallowing navigation is the failure
  // mode this pair of assertions exists to prevent.
  const canNavigate = (await p.navigation.isAvailable?.()) ?? true;
  if (canNavigate) {
    await p.navigation.sendKey("ok");
  } else {
    let refused = false;
    try {
      await p.navigation.sendKey("ok");
    } catch {
      refused = true;
    }
    assert(refused, "navigation reports unavailable but sendKey succeeded anyway");
  }

  // --- optional media, only if advertised ---
  if (p.has("media") && p.media) {
    await p.media.pause();
    await p.media.resume();
  }

  void opts; // reserved for future destructive-check gating
}
