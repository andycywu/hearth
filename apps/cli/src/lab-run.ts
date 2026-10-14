/**
 * `hearth lab` (the window) and `hearth cec` (the same commands, in a terminal).
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { posix } from "node:path";
const { join } = posix;   // this runs on a Pi; paths are POSIX whatever machine the tests run on
import {
  CEC_COMMANDS, diagnoseCec, findCommand, labContext, ringStateForCec, ringStateForDiagnosis, runCecCommand, runCecRaw,
  type CecContext, type CecLabResult, type RingState, type StatusRing,
} from "@hearthkit/adapter-linux";
import type { CliOptions } from "./args.js";
import { createLab, launcherEntry, type Lab } from "./lab.js";

export interface LabIo {
  out(text: string): void;
  err(text: string): void;
}

export interface LabDeps {
  env?: Record<string, string | undefined>;
  /** Resolves when the lab should shut down (SIGINT). */
  interrupted?: Promise<void>;
  /** Substituted in tests. */
  lab?: Lab;
  openWindow?: (url: string) => void;
  cec?: CecContext;
  home?: string;
  node?: string;
  cli?: string;
  write?: (path: string, text: string) => Promise<void>;
  /** The status ring, if there is one: still and dim while the lab waits, moving while a command runs. */
  ring?: StatusRing | undefined;
}

/** The command that opens the lab in a window of its own, on this machine's desktop. */
export function windowCommand(url: string, env: Record<string, string | undefined>, home = homedir()): { cmd: string; args: string[]; env: Record<string, string> } {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return {
    cmd: "chromium",
    // Chromium defaults to X11 and, on the Pi's Wayland-only desktop (labwc), dies with "Missing X server
    // or $DISPLAY" — even with --ozone-platform-hint=auto, which was tried first (found 2026-10-14).
    // --password-store=basic: without it Chromium asks the desktop keyring for a password store and, on a Pi that
    // has never made one, opens a "Choose password for new keyring" dialog on top of the window — which is what
    // made the lab look like it had not opened (seen in a screenshot, 2026-10-14).
    args: [`--app=${url}`, "--ozone-platform=wayland", "--password-store=basic", `--user-data-dir=${join(home, ".config", "hearth", "lab-profile")}`, "--no-first-run", "--no-default-browser-check", "--window-size=1200,800"],
    // Started from ssh there is no desktop in the environment; a Pi's desktop session is on wayland-0.
    env: {
      WAYLAND_DISPLAY: env.WAYLAND_DISPLAY ?? "wayland-0",
      XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
      ...(env.DISPLAY ? { DISPLAY: env.DISPLAY } : {}),
    },
  };
}

function defaultOpen(url: string, env: Record<string, string | undefined>, err: (t: string) => void): void {
  const w = windowCommand(url, env);
  for (const cmd of [w.cmd, "chromium-browser"]) {
    try {
      const child = spawn(cmd, w.args, { detached: true, stdio: "ignore", env: { ...process.env, ...w.env } });
      child.once("error", () => err(`hearth: could not start ${cmd}; open ${url} in a browser instead\n`));
      // A browser that dies at once (no display, no GPU) is not "opened": say so while someone is looking.
      const started = Date.now();
      child.once("exit", (code) => {
        if (code !== 0 && Date.now() - started < 4_000) err(`hearth: ${cmd} exited at once (code ${code ?? "none"}); open ${url} in a browser instead\n`);
      });
      child.unref();
      return;
    } catch { /* try the next name */ }
  }
  err(`hearth: no browser found; open ${url} in one\n`);
}

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

export async function runLab(opts: CliOptions, io: LabIo, deps: LabDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const device = typeof opts.cec === "string" ? opts.cec : "/dev/cec0";

  if (opts.installLauncher) {
    const home = deps.home ?? homedir();
    // Executable, or the desktop shows a file it will not launch.
    const write = deps.write ?? (async (p: string, t: string) => { await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, t, { encoding: "utf8", mode: 0o755 }); });
    const entry = launcherEntry({ node: deps.node ?? process.execPath, cli: deps.cli ?? new URL("./main.js", import.meta.url).pathname });
    const paths = [join(home, ".local", "share", "applications", "hearth-lab.desktop"), join(home, "Desktop", "hearth-lab.desktop")];
    for (const p of paths) { await write(p, entry); io.out(`Wrote ${p}\n`); }
    io.out("Double-click \"Hearth Lab\" on the desktop (you may need to right-click → Allow Launching).\n");
    return 0;
  }

  const lab = deps.lab ?? createLab({ device, lan: opts.labLan, ring: deps.ring, ...(deps.cec ? { cec: deps.cec } : {}) });
  let port: number;
  try {
    port = await lab.listen(opts.labPort ?? 8420);
  } catch (err) {
    io.err(`hearth: cannot listen on port ${opts.labPort ?? 8420}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const local = `http://127.0.0.1:${port}/?t=${lab.token}`;
  io.out(`Hearth Lab is up.\n  On this machine: ${local}\n`);
  if (opts.labLan) {
    const ip = lanAddress();
    io.out(ip ? `  On the network:  http://${ip}:${port}/?t=${lab.token}   (anyone with this address can send CEC commands)\n` : "  On the network: (no LAN address found)\n");
  }
  io.out("Ctrl+C to stop.\n");
  await deps.ring?.show("listening").catch(() => {});     // ready, and still
  if (!opts.noOpen) (deps.openWindow ?? ((u: string) => defaultOpen(u, env, io.err)))(local);

  await (deps.interrupted ?? new Promise<void>(() => {}));
  await lab.close();
  return 0;
}

// ---------------------------------------------------------------------------------------------

const verdictOk = (r: CecLabResult): boolean =>
  (r.verdict === "reply" || r.verdict === "sent") && (!r.readBack || r.readBack.reached);

function formatResult(r: CecLabResult): string {
  const lines: string[] = [];
  for (const s of r.steps) lines.push(`$ ${s.cmdline}${s.code !== 0 ? `   (exit ${s.code})` : ""}`);
  lines.push(`→ ${r.verdict}: ${r.summary}`);
  const facts = Object.entries(r.facts);
  if (facts.length) lines.push(`  ${facts.map(([k, v]) => `${k}: ${v}`).join("   ")}`);
  if (r.readBack) lines.push(`  read-back: wanted ${r.readBack.wanted}, last read ${r.readBack.last ?? "no answer"} after ${(r.readBack.afterMs / 1000).toFixed(1)} s → ${r.readBack.reached ? "VERIFIED" : "NOT verified"}`);
  return lines.join("\n") + "\n";
}

export async function runCecTool(opts: CliOptions, words: string[], io: LabIo, deps: { cec?: CecContext; target?: number; ring?: StatusRing | undefined } = {}): Promise<number> {
  const lit = (state: RingState): Promise<void> => (deps.ring ? deps.ring.show(state).catch(() => {}) : Promise.resolve());
  const device = typeof opts.cec === "string" ? opts.cec : "/dev/cec0";
  const ctx = deps.cec ?? labContext(device);
  const [sub, ...rest] = words;

  if (!sub || sub === "list") {
    io.out("hearth cec <command> [--target N]   |   hearth cec diagnose   |   hearth cec send \"<cec-ctl flags>\"\n\n");
    for (const c of CEC_COMMANDS) io.out(`  ${c.id.padEnd(22)} ${c.changesState ? "⚠ " : "  "}${c.label}\n`);
    io.out("\n⚠ marks commands that change the TV. The same commands, with buttons: hearth lab.\n");
    return 0;
  }

  if (sub === "diagnose") {
    await lit("acting");
    const d = await diagnoseCec(ctx);
    await lit(ringStateForDiagnosis(d));
    for (const s of d.steps) {
      io.out(`  ${{ ok: "✓", warn: "!", fail: "✗", skipped: "–" }[s.status]} ${s.layer.padEnd(18)} ${s.detail}\n`);
      if (s.fix) io.out(`      → ${s.fix}\n`);
    }
    io.out(d.firstProblem ? `\nFirst problem: ${d.firstProblem.layer}.\n` : "\nEvery layer checked is working.\n");
    return d.firstProblem?.status === "fail" ? 1 : 0;
  }

  if (sub === "send") {
    await lit("acting");
    const r = await runCecRaw(ctx, rest.join(" ").split(/\s+/).filter(Boolean));
    await lit(ringStateForCec(r));
    io.out(formatResult(r));
    return verdictOk(r) ? 0 : 1;
  }

  const def = findCommand(sub);
  if (!def) {
    io.err(`hearth: unknown CEC command "${sub}". \`hearth cec list\` shows them.\n`);
    return 2;
  }
  if (def.changesState && !opts.yes) {
    io.err(`hearth: "${def.id}" changes the TV (${def.explain}) Re-run with --yes to send it.\n`);
    return 2;
  }
  await lit("acting");
  const r = await runCecCommand(ctx, def, { target: deps.target ?? opts.target ?? 0 });
  await lit(ringStateForCec(r));
  io.out(formatResult(r));
  return verdictOk(r) ? 0 : 1;
}
