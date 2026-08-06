import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import { detectSpeechEngines } from "@tv-ai-agent/platform-api";

/**
 * On-device capability self-diagnostic.
 *
 * Probes every HAL capability against a live PlatformProvider and returns a
 * structured report. This is the Phase 2 bring-up tool: run it on an MTK/NVT
 * reference board (AOSP or Tizen) to see exactly which capabilities the firmware
 * grants, and paste the resulting rows into docs/platform/capability-matrix.md.
 *
 * Read-only by default. Pass `allowWrites: true` to exercise mutating paths
 * (volume set/restore, a key press) — never runs standby, which is always
 * treated as destructive.
 */

export type ProbeStatus = "ok" | "unsupported" | "error" | "skipped";

export interface ProbeResult {
  capability: string;
  status: ProbeStatus;
  detail?: string;
}

export interface DiagnosticsReport {
  device: {
    os: string;
    osVersion: string;
    soc: string;
    model: string;
  };
  timestamp: string;
  results: ProbeResult[];
  summary: { ok: number; unsupported: number; error: number; skipped: number };
}

export interface DiagnosticsOptions {
  /** Allow mutating probes (volume set/restore, key press). Default false. */
  allowWrites?: boolean;
  /**
   * URLs to actually fetch, to prove the device has a route rather than
   * trusting an adapter's `isOnline`. Opt-in: a diagnostics run shouldn't
   * reach the network unless the caller asked it to.
   */
  reachUrls?: readonly string[];
  /** Per-URL budget for the above. Default 5000ms. */
  reachTimeoutMs?: number;
}

export async function runDiagnostics(
  platform: PlatformProvider,
  opts: DiagnosticsOptions = {},
): Promise<DiagnosticsReport> {
  const results: ProbeResult[] = [];
  const allowWrites = opts.allowWrites ?? false;

  await tryInit(platform, results);

  // --- system: volume ---
  await probe(results, "system.getVolume", async () => {
    const v = await platform.system.getVolume();
    return `${v}`;
  });
  await probe(results, "system.setVolume", async () => {
    if (!allowWrites) return skip("write-guarded (pass allowWrites)");
    const original = await platform.system.getVolume();
    await platform.system.setVolume(Math.min(100, original + 1));
    await platform.system.setVolume(original); // restore
    return `round-trip ok (restored to ${original})`;
  });

  // --- system: mute ---
  await probe(results, "system.getMute", async () => `${await platform.system.getMute()}`);

  // --- system: input source ---
  await probe(results, "system.getInputSource", async () => `${await platform.system.getInputSource()}`);
  await probe(results, "system.setInputSource", async () =>
    skip(allowWrites ? "vendor-gated; not auto-exercised" : "write-guarded"),
  );
  await probe(results, "system.powerStandby", async () => skip("destructive; never auto-run"));

  // --- apps ---
  await probe(results, "apps.listInstalledApps", async () => {
    const apps = await platform.apps.listInstalledApps();
    return `${apps.length} apps`;
  });
  await probe(results, "apps.findAppsByName", async () => {
    const found = await platform.apps.findAppsByName("a");
    return `${found.length} match(es) for "a"`;
  });
  await probe(results, "apps.getForegroundApp", async () => {
    const fg = await platform.apps.getForegroundApp();
    return fg ? `${fg.name}` : "none";
  });

  // --- navigation ---
  await probe(results, "navigation.available", async () => {
    if (!platform.navigation.isAvailable) return "assumed (always available)";
    const ready = await platform.navigation.isAvailable();
    return ready
      ? "ready"
      : skip("not ready — enable the accessibility service (navigation.requestSetup)");
  });
  await probe(results, "navigation.sendKey", async () => {
    if (!allowWrites) return skip("write-guarded (pass allowWrites)");
    await platform.navigation.sendKey("ok");
    return "sent 'ok'";
  });

  // --- network ---
  await probe(results, "network.isOnline", async () => `${await platform.network.isOnline()}`);
  await probe(results, "network.connectionType", async () => `${await platform.network.connectionType()}`);

  // An adapter that can't detect connectivity answers `true` and hopes, so the
  // two probes above can both be green on a device with no route to anything.
  // Actually reaching for a URL is the only honest answer, and "can I reach my
  // model?" is the question bring-up is really asking.
  for (const url of opts.reachUrls ?? []) {
    await probe(results, `network.reach ${shorten(url)}`, async () => {
      if (typeof fetch !== "function") return unsupported();
      const started = Date.now();
      const res = await withTimeout(
        fetch(url, { method: "GET" }),
        opts.reachTimeoutMs ?? 5000,
        `no answer within ${opts.reachTimeoutMs ?? 5000}ms`,
      );
      // Any HTTP status means the packets got there and back, which is what
      // this probe is asking — 404 from a real server still proves the route.
      return `HTTP ${res.status} in ${Date.now() - started}ms`;
    });
  }

  // --- storage (safe round-trip) ---
  await probe(results, "storage.roundTrip", async () => {
    const key = "__diag__";
    await platform.storage.set(key, "1");
    const v = await platform.storage.get(key);
    await platform.storage.delete(key);
    if (v !== "1") throw new Error("value mismatch");
    return "ok";
  });

  // --- optional capabilities ---
  await probe(results, "media", async () =>
    platform.has("media") && platform.media ? "advertised" : unsupported(),
  );
  await probe(results, "voice", async () =>
    platform.has("voice") && platform.voice ? "advertised" : unsupported(),
  );
  // What speech engines this build *could* use, whether or not the adapter wired
  // one up. On a TV that answer is per-vendor and per-firmware, and it decides
  // whether voice needs native code, a vendor agreement, or nothing at all — so
  // it's worth reporting rather than rediscovering per platform.
  await probe(results, "voice.engines", async () => {
    const found = detectSpeechEngines();
    return found.length ? found.join(", ") : "none detected";
  });

  const summary = {
    ok: results.filter((r) => r.status === "ok").length,
    unsupported: results.filter((r) => r.status === "unsupported").length,
    error: results.filter((r) => r.status === "error").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };

  return {
    device: {
      os: platform.device.os,
      osVersion: platform.device.osVersion,
      soc: platform.device.soc,
      model: platform.device.model,
    },
    timestamp: new Date().toISOString(),
    results,
    summary,
  };
}

/** Render a report as a Markdown table (paste-ready for capability-matrix.md). */
export function reportToMarkdown(report: DiagnosticsReport): string {
  const head = `### ${report.device.os} / ${report.device.soc} — ${report.device.model} (${report.device.osVersion})`;
  const rows = report.results
    .map((r) => `| ${r.capability} | ${icon(r.status)} | ${r.detail ?? ""} |`)
    .join("\n");
  return `${head}\n\n| Capability | Status | Detail |\n|---|---|---|\n${rows}\n`;
}

// --- internals ---
const SKIP = Symbol("skip");
const UNSUPPORTED = Symbol("unsupported");
/** Keep the report readable on a TV: origin plus a hint of the path. */
function shorten(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function skip(detail: string): { [SKIP]: string } { return { [SKIP]: detail }; }
function unsupported(): { [UNSUPPORTED]: true } { return { [UNSUPPORTED]: true }; }

async function probe(
  out: ProbeResult[],
  capability: string,
  fn: () => Promise<string | { [SKIP]: string } | { [UNSUPPORTED]: true }>,
): Promise<void> {
  try {
    const r = await fn();
    if (typeof r === "object" && r !== null && SKIP in r) {
      out.push({ capability, status: "skipped", detail: (r as any)[SKIP] });
    } else if (typeof r === "object" && r !== null && UNSUPPORTED in r) {
      out.push({ capability, status: "unsupported" });
    } else {
      out.push({ capability, status: "ok", detail: r as string });
    }
  } catch (e) {
    const msg = (e as Error).message;
    // A "not supported" throw from an adapter is a soft unsupported, not a bug.
    const soft = /not supported|undefined|not a function/i.test(msg);
    out.push({ capability, status: soft ? "unsupported" : "error", detail: msg });
  }
}

async function tryInit(platform: PlatformProvider, out: ProbeResult[]): Promise<void> {
  try {
    await platform.init();
    out.push({ capability: "init", status: "ok" });
  } catch (e) {
    out.push({ capability: "init", status: "error", detail: (e as Error).message });
  }
}

function icon(s: ProbeStatus): string {
  return s === "ok" ? "✅" : s === "unsupported" ? "⚠️" : s === "skipped" ? "⏭️" : "❌";
}
