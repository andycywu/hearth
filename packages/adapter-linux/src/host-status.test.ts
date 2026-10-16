import { describe, expect, it } from "vitest";
import { readHostStatus } from "./host-status.js";
import type { Runner } from "./run.js";

// The values are the shapes a Pi 3B reports (thermal in millidegrees, meminfo in kB, the two proc one-liners),
// with the temperature and memory of the example the hosted-service acceptance test used: 48.2 °C, 312 MB free.
const FILES: Record<string, string> = {
  "/sys/class/thermal/thermal_zone0/temp": "48200\n",
  "/proc/meminfo": "MemTotal:         948304 kB\nMemFree:          120000 kB\nMemAvailable:     319488 kB\nBuffers:           20000 kB\n",
  "/proc/loadavg": "0.42 0.38 0.30 1/153 4242\n",
  "/proc/uptime": "3600.77 12000.10\n",
};
const reader = (files: Record<string, string>) => async (p: string) => {
  if (p in files) return files[p]!;
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const throttled = (raw: string): Runner => async (cmd) =>
  cmd === "vcgencmd" ? { code: 0, stdout: `throttled=${raw}\n`, stderr: "" } : { code: 127, stdout: "", stderr: "" };
const noVcgencmd: Runner = async () => ({ code: 127, stdout: "", stderr: "command not found" });

describe("host status", () => {
  it("reads each field from where Linux keeps it, and uses what can be allocated, not what is merely free", async () => {
    const s = await readHostStatus({ readFile: reader(FILES), run: throttled("0x0") });
    expect(s).toMatchObject({
      online: true, cpu_temperature_c: 48.2, memory_free_mb: 312, memory_total_mb: 926, load_1m: 0.42, uptime_s: 3601, unreadable: [],
    });
    expect(s.power).toMatchObject({ raw: "0x0", under_voltage_now: false, throttled_now: false, under_voltage_since_boot: false });
  });

  it("decodes the throttle bits: 0x50005 is under-voltage and throttled now, and both since boot", async () => {
    // The value this Pi read for a week, on the wrong cable.
    const { power } = await readHostStatus({ readFile: reader(FILES), run: throttled("0x50005") });
    expect(power).toMatchObject({
      under_voltage_now: true, throttled_now: true, frequency_capped_now: false,
      under_voltage_since_boot: true, throttled_since_boot: true,
    });
    // 0x70000: it has happened, it is not happening — the state after the cable was changed.
    expect((await readHostStatus({ readFile: reader(FILES), run: throttled("0x70000") })).power)
      .toMatchObject({ under_voltage_now: false, throttled_now: false, under_voltage_since_boot: true });
  });

  it("a field that cannot be read is null and named, never filled in", async () => {
    const s = await readHostStatus({ readFile: reader({ "/proc/loadavg": "1.00 1 1 1/1 1\n" }), run: noVcgencmd });
    expect(s.cpu_temperature_c).toBeNull();
    expect(s.memory_free_mb).toBeNull();
    expect(s.uptime_s).toBeNull();
    expect(s.load_1m).toBe(1);
    expect(s.unreadable).toEqual(["cpu_temperature_c", "memory_free_mb", "memory_total_mb", "uptime_s"]);
  });

  it("no vcgencmd means no power section — not a Pi, which is not a fault — and garbage from it is unreadable, not zero", async () => {
    expect((await readHostStatus({ readFile: reader(FILES), run: noVcgencmd })).power).toBeNull();
    const garbled: Runner = async () => ({ code: 0, stdout: "something else\n", stderr: "" });
    const s = await readHostStatus({ readFile: reader(FILES), run: garbled });
    expect(s.power).toBeNull();
    expect(s.unreadable).toContain("power");
  });

  it("a runner that throws is the same as a missing command", async () => {
    const boom: Runner = async () => { throw new Error("spawn vcgencmd ENOENT"); };
    expect((await readHostStatus({ readFile: reader(FILES), run: boom })).power).toBeNull();
  });
});
