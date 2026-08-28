import type { KeyValueStore } from "@hearthkit/platform-api";

/**
 * What identifies one installation of this runtime — and, deliberately, what
 * does not.
 *
 * A service business needs to know how many televisions are using it and how
 * often. That is a legitimate question and it does not require watching anyone's
 * living room, so this file draws the line where it can be defended:
 *
 *  - **A random id, generated on the device, stored locally.** Not the Android
 *    ID, not a serial number, not a MAC address, not an advertising id. Those
 *    identify *hardware*, survive a factory reset in some cases, and turn
 *    counting into tracking. Two identical televisions in the same shop get two
 *    different ids here, and a test asserts it.
 *  - **Resettable.** `resetInstallId` issues a new one; the old one is
 *    unrecoverable. A user who wants to be a new installation can be one.
 *  - **Sent only where a call was already going.** The id rides on ModelPilot
 *    requests, which the host opted into by configuring a credential. There is
 *    no analytics endpoint, and with `MODELPILOT_MODE=off` nothing is sent at
 *    all — the runtime stays offline by default and by construction.
 *
 * What a backend can infer from it: how many installs called, how often, from
 * which runtime version, in which mode. What it cannot: who they are, what they
 * watched, or anything about the room. Under GDPR this is still personal data —
 * pseudonymous is not anonymous — so an integrator needs a lawful basis, a
 * retention period and a privacy notice. See docs/service-metrics.md.
 */

export const INSTALL_ID_KEY = "install:id";

/**
 * The runtime version reported alongside the id.
 *
 * A literal rather than a read of `package.json`: the bundle has no filesystem,
 * and a build-time inject would be one more thing that can silently drift. Bump
 * it with the package version.
 */
export const RUNTIME_VERSION = "0.2.0";

const PREFIX = "hth_";
const ID_BYTES = 16;

export interface InstallIdOptions {
  /** Injected by tests. Defaults to `crypto.getRandomValues` where available. */
  random?: (bytes: number) => Uint8Array;
  key?: string;
}

/**
 * The id for this installation, creating one the first time.
 *
 * Storage failures are not fatal: a device whose storage is unavailable gets an
 * ephemeral id for this session rather than no runtime. It will be counted as a
 * new install every boot, which overstates device count — so the doc says that
 * out loud rather than letting someone trust the number.
 */
export async function loadInstallId(
  storage: KeyValueStore,
  opts: InstallIdOptions = {},
): Promise<string> {
  const key = opts.key ?? INSTALL_ID_KEY;
  try {
    const existing = await storage.get(key);
    if (existing && isPlausibleInstallId(existing)) return existing;
  } catch {
    return generateInstallId(opts.random);
  }

  const fresh = generateInstallId(opts.random);
  try {
    await storage.set(key, fresh);
  } catch {
    /* ephemeral for this session; see above */
  }
  return fresh;
}

/** Issue a new id and forget the old one. Irreversible, on purpose. */
export async function resetInstallId(
  storage: KeyValueStore,
  opts: InstallIdOptions = {},
): Promise<string> {
  const key = opts.key ?? INSTALL_ID_KEY;
  const fresh = generateInstallId(opts.random);
  await storage.set(key, fresh);
  return fresh;
}

export function generateInstallId(random?: (bytes: number) => Uint8Array): string {
  const bytes = random ? random(ID_BYTES) : randomBytes(ID_BYTES);
  let out = PREFIX;
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function isPlausibleInstallId(value: string): boolean {
  return new RegExp(`^${PREFIX}[0-9a-f]{${ID_BYTES * 2}}$`).test(value.trim());
}

/**
 * Random bytes, from the platform's CSPRNG where there is one.
 *
 * The fallback is `Math.random`, which is not cryptographically strong — and for
 * this purpose that is acceptable and worth saying why: the id is a counting
 * handle, not a secret or a capability. A weak id risks a collision between two
 * televisions, which slightly undercounts installs. It does not risk
 * impersonation, because the id authorises nothing; the API key does that.
 */
function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  const webcrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (webcrypto?.getRandomValues) return webcrypto.getRandomValues(out);
  for (let i = 0; i < count; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}
