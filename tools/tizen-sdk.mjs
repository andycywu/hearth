/**
 * Finding the Tizen toolchain — which is harder than it should be, because a
 * machine can have two complete, independent installations:
 *
 *   1. The **VS Code Tizen extension**, which bundles its own SDK under
 *      ~/.tizen-extension-platform/server/sdktools/ — its own `tz`, its own
 *      `sdb`, and crucially its own `sdk-data/profile/profiles.xml`.
 *   2. A legacy **Tizen Studio** install at C:\tizen-studio (Tizen Studio is EOL).
 *
 * Certificates created in VS Code land in (1). Signing with (2)'s profile
 * produces a `.wgt` the device rejects at install time, and the error says
 * nothing about which SDK you used. We prefer (1) and print which one we picked.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const isWin = process.platform === "win32";
const exe = (name) => (isWin ? `${name}.exe` : name);
const home = process.env.USERPROFILE ?? process.env.HOME;

/** Candidate SDK roots, best first. */
function roots() {
  return [
    home && {
      kind: "vscode-extension",
      root: join(home, ".tizen-extension-platform", "server", "sdktools"),
      toolsDir: join(home, ".tizen-extension-platform", "server", "sdktools", "data", "tools"),
      dataDir: join(home, ".tizen-extension-platform", "server", "sdktools", "sdk-data"),
    },
    { kind: "tizen-studio", root: "C:\\tizen-studio", toolsDir: "C:\\tizen-studio\\tools",
      dataDir: "C:\\tizen-studio-data" },
    home && {
      kind: "tizen-studio", root: join(home, "tizen-studio"),
      toolsDir: join(home, "tizen-studio", "tools"), dataDir: join(home, "tizen-studio-data"),
    },
    { kind: "tizen-studio", root: "/opt/tizen-studio", toolsDir: "/opt/tizen-studio/tools",
      dataDir: "/opt/tizen-studio-data" },
  ].filter(Boolean);
}

/**
 * @returns {{kind:string, root:string, tz:string, sdb?:string, profilesXml?:string}[]}
 *   every usable installation, best first.
 */
export function findTizenSdks() {
  const found = [];
  for (const c of roots()) {
    const tz = join(c.toolsDir, "tizen-core", exe("tz"));
    if (!existsSync(tz)) continue;
    const sdb = [join(c.toolsDir, exe("sdb")), join(c.root, "tools", exe("sdb"))].find(existsSync);
    const profilesXml = join(c.dataDir, "profile", "profiles.xml");
    found.push({
      kind: c.kind, root: c.root, tz,
      ...(sdb ? { sdb } : {}),
      ...(existsSync(profilesXml) ? { profilesXml } : {}),
    });
  }
  return found;
}

/**
 * The one to use. `TIZEN_CORE` (a path to `tz`) overrides the search entirely,
 * for anyone with a layout we haven't seen.
 */
export function findTizenSdk(explicitTz = process.env.TIZEN_CORE) {
  if (explicitTz && existsSync(explicitTz)) {
    return { kind: "explicit", root: explicitTz, tz: explicitTz };
  }
  return findTizenSdks()[0];
}
