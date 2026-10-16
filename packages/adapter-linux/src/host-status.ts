import { readFile } from "node:fs/promises";
import type { FileReader } from "./host.js";
import { systemRunner, type Runner } from "./run.js";

/**
 * How this box is doing — the thing a person means by "is the Pi okay?".
 *
 * A read, for the agent to answer questions with. Every field is read from where Linux keeps it, and a field that
 * could not be read is `null` and named in `unreadable` rather than filled with a plausible number: "the CPU is at
 * 48 °C" that nobody measured is exactly the answer this project exists not to give.
 *
 *  - temperature: `/sys/class/thermal/thermal_zone0/temp` (millidegrees)
 *  - memory: `/proc/meminfo`, `MemAvailable` — what can actually be allocated, not `MemFree`
 *  - load and uptime: `/proc/loadavg`, `/proc/uptime`
 *  - power: `vcgencmd get_throttled`, on a Raspberry Pi. The bits are documented by the Pi Foundation; the ones that
 *    matter here are the *current* under-voltage and throttle (0–3) and whether either has happened since boot
 *    (16–19). This Pi's first week was an under-voltage that turned out to be a cable, so it is in the answer.
 */
export interface HostStatus {
  online: true;
  cpu_temperature_c: number | null;
  memory_free_mb: number | null;
  memory_total_mb: number | null;
  load_1m: number | null;
  uptime_s: number | null;
  /** Absent on a box with no `vcgencmd`: not a Pi, not a problem. */
  power: PowerStatus | null;
  /** What could not be read, by field name. */
  unreadable: string[];
}

export interface PowerStatus {
  raw: string;
  under_voltage_now: boolean;
  frequency_capped_now: boolean;
  throttled_now: boolean;
  soft_temperature_limit_now: boolean;
  under_voltage_since_boot: boolean;
  throttled_since_boot: boolean;
}

export interface HostStatusDeps {
  readFile?: FileReader;
  run?: Runner;
}

export async function readHostStatus(deps: HostStatusDeps = {}): Promise<HostStatus> {
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const run = deps.run ?? systemRunner();
  const unreadable: string[] = [];
  const text = async (path: string): Promise<string | undefined> => {
    try { return await read(path); } catch { return undefined; }
  };
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v?.trim());
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) ? n : undefined;
  };
  const miss = <T>(name: string, value: T | undefined): T | null => {
    if (value === undefined) { unreadable.push(name); return null; }
    return value;
  };

  const milli = num(await text("/sys/class/thermal/thermal_zone0/temp"));
  const meminfo = (await text("/proc/meminfo")) ?? "";
  const kb = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(meminfo);
    return m ? Number(m[1]) : undefined;
  };
  const avail = kb("MemAvailable"), total = kb("MemTotal");
  const load = num((await text("/proc/loadavg"))?.split(/\s+/)[0]);
  const uptime = num((await text("/proc/uptime"))?.split(/\s+/)[0]);

  let power: PowerStatus | null = null;
  const throttled = await run("vcgencmd", ["get_throttled"]).catch(() => undefined);
  if (throttled && throttled.code === 0) {
    const m = /throttled=(0x[0-9a-fA-F]+)/.exec(throttled.stdout);
    if (m) {
      const bits = Number(m[1]);
      const bit = (n: number): boolean => (bits & (1 << n)) !== 0;
      power = {
        raw: m[1]!,
        under_voltage_now: bit(0), frequency_capped_now: bit(1), throttled_now: bit(2), soft_temperature_limit_now: bit(3),
        under_voltage_since_boot: bit(16), throttled_since_boot: bit(18),
      };
    } else unreadable.push("power");
  }

  return {
    online: true,
    cpu_temperature_c: miss("cpu_temperature_c", milli === undefined ? undefined : Math.round(milli / 100) / 10),
    memory_free_mb: miss("memory_free_mb", avail === undefined ? undefined : Math.round(avail / 1024)),
    memory_total_mb: miss("memory_total_mb", total === undefined ? undefined : Math.round(total / 1024)),
    load_1m: miss("load_1m", load),
    uptime_s: miss("uptime_s", uptime === undefined ? undefined : Math.round(uptime)),
    power,
    unreadable,
  };
}
