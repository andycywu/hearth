import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `tools/install.sh` puts a `hearth` command in ~/.local/bin. It is a shell script, so it is exercised the way it
 * runs: under `sh`, in a throwaway HOME, with a stand-in `node` that says it is version 26 and prints what it was
 * given — nothing is built, nothing real is spawned, and the launcher it writes is then run.
 */
const posix = (p: string) => p.replaceAll("\\", "/");
const script = posix(fileURLToPath(new URL("../../../tools/install.sh", import.meta.url)));
// Windows resolves `sh` through its own PATH, which the sandbox replaces; the script is for Linux and runs there (CI, the Pi).
const hasSh = process.platform !== "win32" && !spawnSync("sh", ["-c", "true"]).error;
const built = existsSync(fileURLToPath(new URL("../dist/main.js", import.meta.url)));

function sandbox() {
  const home = posix(mkdtempSync(join(tmpdir(), "hearth-install-")));
  const bin = `${home}/fakebin`;
  mkdirSync(bin, { recursive: true });
  // A node that is "26", and otherwise echoes its arguments and one variable the env file is meant to provide.
  writeFileSync(`${bin}/node`, [
    "#!/bin/sh",
    'case "$1" in',
    "  -p) echo 26 ;;",
    "  --version) echo v26.0.0 ;;",
    '  *) echo "ARGS:$* KEY:${HEARTH_TEST_KEY:-unset}" ;;',
    "esac",
    "",
  ].join("\n"));
  chmodSync(`${bin}/node`, 0o755);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, XDG_CONFIG_HOME: `${home}/cfg` };
  const run = (...args: string[]) => spawnSync("sh", [script, ...args], { env, encoding: "utf8" });
  return { home, bin, env, run, launcher: `${home}/.local/bin/hearth` };
}

describe.skipIf(!hasSh || !built)("tools/install.sh", () => {
  it("installs an executable launcher that finds Node, reads the env file, and runs this checkout's build", () => {
    const s = sandbox();
    const r = s.run("--no-build");
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(s.launcher).mode & 0o111).not.toBe(0);

    const text = readFileSync(s.launcher, "utf8");
    expect(text).toContain(`export PATH="${s.bin}:$PATH"`);        // Node first: works from a non-interactive ssh command
    expect(text).toContain("apps/cli/dist/main.js");
    expect(text).not.toMatch(/sk-|api[_-]?key=/i);                   // the launcher holds no secret, only where to look

    // Run it as a user would: a key in the 0600 file reaches the process; the arguments pass through untouched.
    mkdirSync(`${s.home}/cfg/hearth`, { recursive: true });
    writeFileSync(`${s.home}/cfg/hearth/env`, "HEARTH_TEST_KEY=from-the-file\n", { mode: 0o600 });
    const ran = spawnSync("sh", [s.launcher, "turn it down"], { env: s.env, encoding: "utf8" });
    expect(ran.stdout).toContain("KEY:from-the-file");
    expect(ran.stdout).toContain("main.js turn it down");
  });

  it("puts ~/.local/bin on PATH once, in ~/.profile, and says how to pick it up", () => {
    const s = sandbox();
    const first = s.run("--no-build");
    expect(first.stdout).toContain("added");
    s.run("--no-build");
    const profile = readFileSync(`${s.home}/.profile`, "utf8");
    expect(profile.match(/# hearth/g)).toHaveLength(1);              // idempotent
    expect(first.stdout).toMatch(/\. ~\/\.profile/);
  });

  it("refuses to run without Node 26, saying where it looked and what to do", () => {
    const s = sandbox();
    writeFileSync(`${s.bin}/node`, '#!/bin/sh\ncase "$1" in -p) echo 22 ;; --version) echo v22.0.0 ;; esac\n');
    const r = s.run("--no-build");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Node 26 or newer/);
    expect(existsSync(s.launcher)).toBe(false);
  });

  it("--uninstall removes its own launcher and leaves a file it did not write alone", () => {
    const s = sandbox();
    s.run("--no-build");
    expect(s.run("--uninstall").stdout).toContain("removed");
    expect(existsSync(s.launcher)).toBe(false);

    mkdirSync(`${s.home}/.local/bin`, { recursive: true });
    writeFileSync(s.launcher, "#!/bin/sh\necho not ours\n");
    expect(s.run("--uninstall").stdout).toContain("nothing removed");
    expect(readFileSync(s.launcher, "utf8")).toContain("not ours");
  });

  it("rejects an option it does not know instead of ignoring it", () => {
    expect(sandbox().run("--nope").status).toBe(2);
  });
});
