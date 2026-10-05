import { readFile } from "node:fs/promises";
import { release } from "node:os";

/**
 * What this box is, for the one line at the top of a Hearth Report.
 *
 * "Linux" is not a device any more than "Android TV" is. A report that says
 * `Raspberry Pi 3 Model B Rev 1.2 · Raspberry Pi OS 13 (trixie) · 6.18.50-v8`
 * can be compared with the next one; a report that says `Linux v26.10.0` (which
 * is what this adapter used to put there — the *Node* version) cannot, and was
 * mislabelled besides.
 *
 * Three files, each optional, each read once:
 *
 *  - `/proc/device-tree/model` — the board, on ARM boards that have one. It is
 *    NUL-terminated, which is why the trim below strips `\0`.
 *  - `/etc/os-release` — `PRETTY_NAME`, the distribution as it names itself.
 *  - `/proc/device-tree/compatible` — the SoC, as a vendor hint. `brcm,bcm2837`
 *    becomes `broadcom`; a board with no device tree stays `unknown`, which is
 *    the honest default rather than a guess from `uname -m`.
 */
export interface HostIdentity {
  /** The board, or `Linux` when nothing names it. */
  model: string;
  /** Distribution and kernel: `Raspberry Pi OS 13 (trixie) · 6.18.50-v8`. */
  osVersion: string;
  /** SoC vendor in lower case, `unknown` when the device tree does not say. */
  soc: string;
}

export type FileReader = (path: string) => Promise<string>;

const SOC_VENDORS: Record<string, string> = {
  brcm: "broadcom",
  mediatek: "mediatek",
  mtk: "mediatek",
  rockchip: "rockchip",
  amlogic: "amlogic",
  allwinner: "allwinner",
  nvidia: "nvidia",
  qcom: "qualcomm",
  novatek: "novatek",
  nvt: "novatek",
};

export async function describeHost(read: FileReader = defaultReader, kernel = release()): Promise<HostIdentity> {
  const model = clean(await read("/proc/device-tree/model"));
  const osRelease = await read("/etc/os-release");
  const compatible = clean(await read("/proc/device-tree/compatible"));

  const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease)?.[1]?.trim();
  const osVersion = [pretty, kernel].filter(Boolean).join(" · ") || "unknown";

  return {
    model: model || "Linux",
    osVersion,
    soc: socFrom(compatible),
  };
}

/** `raspberrypi,3-model-b\0brcm,bcm2837\0` → `broadcom`. */
export function socFrom(compatible: string): string {
  // The device tree lists the most specific binding first and the SoC last;
  // any entry whose vendor we know will do, but prefer the last one, which is
  // the SoC rather than the board.
  const entries = compatible.split(/\0|\s+/).map((e) => e.trim()).filter(Boolean);
  for (const entry of [...entries].reverse()) {
    const vendor = entry.split(",")[0]!.toLowerCase();
    const known = SOC_VENDORS[vendor];
    if (known) return known;
  }
  return "unknown";
}

function clean(text: string): string {
  return text.replace(/\0+$/g, "").replace(/\0/g, " ").trim();
}

/** Missing or unreadable means "this box does not say", never an error. */
async function defaultReader(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
