import { describe, it, expect } from "vitest";
import { describeHost, socFrom } from "./host.js";
import { createLinuxAdapter } from "./index.js";
import type { Runner, RunResult } from "./run.js";

/**
 * Real file contents from a Raspberry Pi 3B running Raspberry Pi OS, NULs and
 * all — the device tree terminates strings with `\0`, and the first version of
 * this module put the NUL into the report heading.
 */
const PI_FILES: Record<string, string> = {
  "/proc/device-tree/model": "Raspberry Pi 3 Model B Rev 1.2\0",
  "/proc/device-tree/compatible": "raspberrypi,3-model-b\0brcm,bcm2837\0",
  "/etc/os-release": [
    'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"',
    'NAME="Debian GNU/Linux"',
    'VERSION_ID="13"',
    "ID=debian",
  ].join("\n"),
};
const files = (table: Record<string, string>) => async (path: string) => table[path] ?? "";

describe("describing the box a report comes from", () => {
  it("names a Pi by its device tree, its distribution and its kernel", async () => {
    const host = await describeHost(files(PI_FILES), "6.18.50-v8");
    expect(host).toEqual({
      model: "Raspberry Pi 3 Model B Rev 1.2",
      osVersion: "Debian GNU/Linux 13 (trixie) · 6.18.50-v8",
      soc: "broadcom",
    });
  });

  it("falls back to plain Linux on a box with no device tree", async () => {
    // An x86 laptop: no /proc/device-tree at all, os-release present.
    const host = await describeHost(files({ "/etc/os-release": "PRETTY_NAME=Ubuntu 26.04 LTS\n" }), "6.14.0");
    expect(host).toEqual({ model: "Linux", osVersion: "Ubuntu 26.04 LTS · 6.14.0", soc: "unknown" });
  });

  it("says unknown rather than guessing when nothing is readable", async () => {
    const host = await describeHost(files({}), "");
    expect(host).toEqual({ model: "Linux", osVersion: "unknown", soc: "unknown" });
  });

  it("reads the SoC vendor off the last compatible entry", () => {
    expect(socFrom("raspberrypi,3-model-b\0brcm,bcm2837\0")).toBe("broadcom");
    expect(socFrom("mediatek,mt8195-evb\0mediatek,mt8195\0")).toBe("mediatek");
    expect(socFrom("acme,board\0")).toBe("unknown");
    expect(socFrom("")).toBe("unknown");
  });
});

describe("the adapter's device line", () => {
  const missing: RunResult = { code: 127, stdout: "", stderr: "command not found" };
  const noTools: Runner = async () => missing;

  it("puts the board in the model and the distribution in osVersion, not the Node version", async () => {
    const platform = createLinuxAdapter({ run: noTools, apps: [], readFile: files(PI_FILES) });
    await platform.init();
    expect(platform.device.model).toBe("Raspberry Pi 3 Model B Rev 1.2");
    expect(platform.device.osVersion).toMatch(/^Debian GNU\/Linux 13 \(trixie\) · /);
    expect(platform.device.osVersion).not.toContain(process.version);
    expect(platform.device.soc).toBe("broadcom");
  });

  it("keeps the audio backend in the model string, because it is how volume gets set here", async () => {
    const wpctl: Runner = async (cmd) =>
      cmd === "wpctl" ? { code: 0, stdout: "Volume: 0.35\n", stderr: "" } : missing;
    const platform = createLinuxAdapter({ run: wpctl, apps: [], readFile: files(PI_FILES) });
    await platform.init();
    expect(platform.device.model).toBe("Raspberry Pi 3 Model B Rev 1.2 (wireplumber)");
  });
});
