import { describe, it, expect } from "vitest";
import { runDiagnostics, reportToMarkdown } from "./probe.js";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";

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

  it("renders a markdown table", async () => {
    const md = reportToMarkdown(await runDiagnostics(createWebAdapter()));
    expect(md).toContain("| Capability | Status | Detail |");
    expect(md).toContain("system.getVolume");
  });
});
