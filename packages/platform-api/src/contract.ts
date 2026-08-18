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
import { isTvUnsupported } from "./errors.js";
import type { PlatformProvider } from "./index.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[provider-contract] ${msg}`);
}

/**
 * Does this capability exist on this device?
 *
 * Only a typed `unsupported` counts as "no". A failure — a timeout, a bus that
 * did not answer — is a bad moment, and treating it as an absent capability
 * would let a flaky device pass a contract it does not satisfy.
 */
async function supported(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (err) {
    if (isTvUnsupported(err)) return false;
    throw err;
  }
}

/** Did this call refuse in the typed way, rather than quietly doing nothing? */
async function refuses(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return false;
  } catch (err) {
    return isTvUnsupported(err);
  }
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
  assert(
    ["aosp", "tizen", "webos", "web", "linux", "titan", "xumo"].includes(p.device.os),
    `unexpected os: ${p.device.os}`,
  );
  assert(typeof p.device.soc === "string", "device.soc must be a string");
  assert(typeof p.init === "function", "init() must exist");
  assert(typeof p.has === "function", "has() must exist");

  await p.init(); // must be idempotent-safe to call at startup

  // --- capability probe ---
  assert(p.has("system") === true, "system control is mandatory");
  assert(p.has("apps") === true, "app control is mandatory");
  assert(p.has("navigation") === true, "navigation is mandatory");
  assert(p.has("storage") === true, "storage is mandatory");

  // --- volume: round-trips and clamps, or refuses consistently ---
  //
  // "Refuses consistently" is the part that took a real device to learn. This
  // used to require volume, mute and an app list to *work*, which quietly said
  // that a conforming adapter is one running on a TV with all of them. The Tizen
  // TV emulator has no audio API at all, and a Xumo or Titan build reaches
  // volume through a platform-privileged path an app may not have — those are
  // not broken adapters, they are smaller ones, and the agent already has a
  // first-class answer for them (`unsupported`, which withdraws the capability).
  //
  // So the contract now checks *coherence* rather than presence: either the
  // group round-trips, or every call in it refuses with a typed `unsupported`.
  // What it still refuses to allow is the shape that actually hurts — a read
  // that answers and a write that silently does nothing.
  if (await supported(() => p.system.getVolume())) {
    await p.system.setVolume(30);
    const v = await p.system.getVolume();
    assert(v >= 0 && v <= 100, `volume out of range: ${v}`);
    await p.system.setVolume(999);
    const vHigh = await p.system.getVolume();
    assert(vHigh <= 100, `volume not clamped at 100: ${vHigh}`);
    await p.system.setVolume(-50);
    const vLow = await p.system.getVolume();
    assert(vLow >= 0, `volume not clamped at 0: ${vLow}`);
  } else {
    assert(
      await refuses(() => p.system.setVolume(30)),
      "getVolume reports unsupported but setVolume accepted the call anyway",
    );
  }

  // --- mute round-trips, or refuses consistently ---
  if (await supported(() => p.system.getMute())) {
    await p.system.setMute(true);
    assert((await p.system.getMute()) === true, "mute did not report true");
    await p.system.setMute(false);
    assert((await p.system.getMute()) === false, "unmute did not report false");
  } else {
    assert(
      await refuses(() => p.system.setMute(true)),
      "getMute reports unsupported but setMute accepted the call anyway",
    );
  }

  // --- apps: list + name lookup, or refuse consistently ---
  if (await supported(() => p.apps.listInstalledApps())) {
    const apps = await p.apps.listInstalledApps();
    assert(Array.isArray(apps), "listInstalledApps must return an array");
    for (const a of apps) {
      assert(typeof a.id === "string" && a.id.length > 0, "app.id must be a non-empty string");
      assert(typeof a.name === "string", "app.name must be a string");
    }
    const found = await p.apps.findAppsByName("");
    assert(Array.isArray(found) && found.length === 0, "empty query must return no matches");
  } else {
    // A device that cannot enumerate apps cannot resolve a spoken name to an id,
    // so offering to launch one would be a promise nothing can keep.
    assert(
      await refuses(() => p.apps.launchApp("com.example.app")),
      "listInstalledApps reports unsupported but launchApp accepted an id anyway",
    );
  }

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
