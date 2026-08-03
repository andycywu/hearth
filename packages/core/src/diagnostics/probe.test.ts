import { describe, it, expect } from "vitest";
import { runDiagnostics, reportToMarkdown, type DiagnosticsReport } from "./probe.js";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";

const status = (r: DiagnosticsReport, capability: string): string | undefined =>
  r.results.find((x) => x.capability === capability)?.status;
const detail = (r: DiagnosticsReport, capability: string): string | undefined =>
  r.results.find((x) => x.capability === capability)?.detail;

describe("runDiagnostics", () => {
  it("reports ok for supported capabilities on the web adapter", async () => {
    const report = await runDiagnostics(createWebAdapter());
    expect(report.device.os).toBe("web");
    expect(report.summary.error).toBe(0);
    const vol = report.results.find((r) => r.capability === "system.getVolume");
    expect(vol?.status).toBe("ok");
    // write-guarded by default
    const setVol = report.results.find((r) => r.capability === "system.setVolume");
    expect(setVol?.status).toBe("skipped");
  });

  it("exercises writes when allowed", async () => {
    const report = await runDiagnostics(createWebAdapter(), { allowWrites: true });
    const setVol = report.results.find((r) => r.capability === "system.setVolume");
    expect(setVol?.status).toBe("ok");
  });

  it("leaves the volume exactly as it found it after the write probe", async () => {
    // The probe runs on someone's TV: a bring-up report must not change settings.
    const platform = createWebAdapter();
    await platform.system.setVolume(37);
    const report = await runDiagnostics(platform, { allowWrites: true });
    expect(await platform.system.getVolume()).toBe(37);
    expect(detail(report, "system.setVolume")).toContain("restored to 37");
  });

  it("never auto-runs the destructive or vendor-gated writes", async () => {
    const report = await runDiagnostics(createWebAdapter(), { allowWrites: true });
    expect(status(report, "system.powerStandby")).toBe("skipped");
    expect(detail(report, "system.powerStandby")).toMatch(/destructive/i);
    expect(status(report, "system.setInputSource")).toBe("skipped");
  });

  it("reports navigation ready on the web adapter and sends a key when allowed", async () => {
    const readOnly = await runDiagnostics(createWebAdapter());
    expect(status(readOnly, "navigation.available")).toBe("ok");
    expect(detail(readOnly, "navigation.available")).toBe("ready");
    expect(status(readOnly, "navigation.sendKey")).toBe("skipped");

    const writes = await runDiagnostics(createWebAdapter(), { allowWrites: true });
    expect(status(writes, "navigation.sendKey")).toBe("ok");
  });

  it("flags navigation as needing setup when the adapter isn't ready", async () => {
    // The AOSP case: keys only work once the user enables the accessibility
    // service, so the report must point at the fix instead of erroring.
    const platform = createWebAdapter();
    platform.navigation.isAvailable = async () => false;
    const report = await runDiagnostics(platform);
    expect(status(report, "navigation.available")).toBe("skipped");
    expect(detail(report, "navigation.available")).toMatch(/accessibility service/i);
    expect(report.summary.error).toBe(0);
  });

  it("assumes navigation works when the adapter can't tell (no isAvailable)", async () => {
    const platform = createWebAdapter();
    delete platform.navigation.isAvailable;
    const report = await runDiagnostics(platform);
    expect(status(report, "navigation.available")).toBe("ok");
    expect(detail(report, "navigation.available")).toMatch(/assumed/i);
  });

  it("marks an optional capability the device lacks as unsupported, not an error", async () => {
    const platform = createWebAdapter();
    delete platform.media;           // e.g. a build with no player integration
    const report = await runDiagnostics(platform);
    expect(status(report, "media")).toBe("unsupported");
    expect(status(report, "voice")).toBe("unsupported"); // no Web Speech in Node
    expect(report.summary.error).toBe(0);
  });

  it("records a genuinely broken capability as an error", async () => {
    const platform = createWebAdapter();
    platform.system.getVolume = async () => { throw new Error("audio service died"); };
    const report = await runDiagnostics(platform);
    expect(status(report, "system.getVolume")).toBe("error");
    expect(report.summary.error).toBe(1);
  });

  describe("network reachability", () => {
    const withFetch = async <T>(impl: unknown, run: () => Promise<T>): Promise<T> => {
      const original = (globalThis as Record<string, unknown>).fetch;
      (globalThis as Record<string, unknown>).fetch = impl;
      try { return await run(); } finally { (globalThis as Record<string, unknown>).fetch = original; }
    };

    it("doesn't touch the network unless asked", async () => {
      // A capability report must not phone home on its own.
      let called = false;
      const report = await withFetch(async () => { called = true; return { status: 200 }; },
        () => runDiagnostics(createWebAdapter()));
      expect(called).toBe(false);
      expect(report.results.some((r) => r.capability.startsWith("network.reach"))).toBe(false);
    });

    it("counts any HTTP status as reachable — the route is what's being tested", async () => {
      const report = await withFetch(async () => ({ status: 404 }),
        () => runDiagnostics(createWebAdapter(), { reachUrls: ["https://api.example.com/v1/models"] }));
      expect(status(report, "network.reach https://api.example.com/v1/models")).toBe("ok");
      expect(detail(report, "network.reach https://api.example.com/v1/models")).toMatch(/HTTP 404/);
    });

    it("records a refused connection as an error, with the reason", async () => {
      // This is the case that matters: isOnline can say true while nothing routes.
      const report = await withFetch(async () => { throw new TypeError("Failed to fetch"); },
        () => runDiagnostics(createWebAdapter(), { reachUrls: ["http://127.0.0.1:9090/v1/models"] }));
      expect(status(report, "network.reach http://127.0.0.1:9090/v1/models")).toBe("error");
      expect(detail(report, "network.reach http://127.0.0.1:9090/v1/models")).toMatch(/Failed to fetch/);
    });

    it("times out rather than hanging the whole report", async () => {
      const report = await withFetch(() => new Promise(() => {}),
        () => runDiagnostics(createWebAdapter(), { reachUrls: ["https://slow.example.com"], reachTimeoutMs: 20 }));
      expect(status(report, "network.reach https://slow.example.com")).toBe("error");
      expect(detail(report, "network.reach https://slow.example.com")).toMatch(/no answer within 20ms/);
    });

    it("probes each URL, so 'host unreachable' and 'no network' are separable", async () => {
      const seen: string[] = [];
      const report = await withFetch(async (url: string) => { seen.push(url); return { status: 200 }; },
        () => runDiagnostics(createWebAdapter(), {
          reachUrls: ["http://127.0.0.1:9090/v1/models", "https://api.open-meteo.com/v1/forecast"],
        }));
      expect(seen).toHaveLength(2);
      expect(report.results.filter((r) => r.capability.startsWith("network.reach"))).toHaveLength(2);
    });
  });

  it("renders a markdown table", async () => {
    const md = reportToMarkdown(await runDiagnostics(createWebAdapter()));
    expect(md).toContain("| Capability | Status | Detail |");
    expect(md).toContain("system.getVolume");
  });
});
