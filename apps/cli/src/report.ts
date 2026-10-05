/**
 * `hearth report` — the Hub's half of the Hearth Report.
 *
 * The television hosts answer `window.__hearthReport()`; a box with a shell and
 * no browser answers this. Same collector, same markdown, so a report from a Pi
 * beside the TV lands in `docs/platform/capability-matrix.md` next to one taken
 * from the TV itself, and the two can be read against each other.
 *
 * What a Linux box adds that a television cannot: the CEC bus. A set's own
 * adapter can only ever report on the set. The Pi sees the console, the AVR and
 * the TV from outside, which is the one vantage point from which "the TV
 * accepted the command and did nothing" is visible for every device at once.
 */
import { writeFile } from "node:fs/promises";
import { version as nodeVersion } from "node:process";
import {
  Agent, collectDeviceReport, deviceReportToMarkdown, DEFAULT_INTENTS, RUNTIME_VERSION,
  type DeviceReport,
} from "@hearthkit/core";
import { createScriptedClient } from "@hearthkit/llm-connectors";
import type { PlatformProvider } from "@hearthkit/platform-api";
import type { CliOptions } from "./args.js";
import { assembleRoom, type RoomDeps } from "./room.js";

export interface ReportIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface ReportResult {
  report: DeviceReport;
  markdown: string;
}

export async function runReport(
  opts: CliOptions,
  platform: PlatformProvider,
  io: ReportIo,
  deps: Omit<RoomDeps, "persist"> = {},
): Promise<number> {
  const log = (line: string): void => { if (!opts.quiet) io.err(`hearth: ${line}\n`); };

  const room = await assembleRoom(opts, platform, { ...deps, persist: false });
  for (const note of [...room.notes, ...room.tree]) log(note);

  // No model. The four scenarios are the deterministic planner's territory, and
  // a report that depended on which LLM happened to be reachable would be a
  // report about the LLM. The planning-cost section says how many plans needed
  // one anyway — on a complete capability graph the answer is none.
  const agent = new Agent({
    platform,
    llm: createScriptedClient(),
    devices: room.devices,
    ...(room.capabilities.length ? { capabilities: room.capabilities } : {}),
    ...(room.tools.length ? { tools: room.tools } : {}),
    // A gated step — waking a console, switching the TV's input — runs only
    // with --yes. Without it the step is *declined* and the report says so,
    // which is a real answer about policy rather than a hole in the data.
    confirm: async () => opts.yes,
  });

  const probed = await agent.probeCapabilities();
  for (const note of probed.notes) log(note);

  const notes = [
    `hearth ${RUNTIME_VERSION} CLI on Node ${nodeVersion}; room seeded as \`${opts.room}\``,
    opts.writes
      ? "probe ran with writes: one volume round-trip was performed"
      : "probe ran read-only (`--writes` to let it round-trip the volume)",
    opts.yes
      ? "gated steps were approved automatically (`--yes`)"
      : "gated steps were declined — nobody was here to approve them; re-run with `--yes` to let them run",
    ...room.notes.map((n) => `transport: ${n}`),
  ];

  const report = await collectDeviceReport({
    agent, platform,
    intents: opts.intents ?? DEFAULT_INTENTS,
    allowWrites: opts.writes,
    notes,
  });
  const markdown = deviceReportToMarkdown(report);

  if (opts.out) {
    await writeFile(opts.out, markdown + "\n", "utf8");
    log(`wrote ${opts.out}`);
  }
  if (opts.json) {
    io.out(JSON.stringify(report, null, 2) + "\n");
  } else if (!opts.out) {
    io.out(markdown + "\n");
  }

  if (!opts.quiet) {
    const summary = report.diagnostics.summary;
    io.err(
      `hearth: ${summary.ok} ok · ${summary.unsupported} unsupported · ${summary.error} error · ` +
      `${report.acceptedButDidNothing.length} accepted-but-did-nothing\n` +
      "hearth: that is a Hearth Report section. Paste it into an issue at\n" +
      "        https://github.com/andycywu/hearth/issues/new — or open a PR adding it to\n" +
      "        docs/platform/capability-matrix.md.\n",
    );
  }
  // The exit code is about the *run*, not the device: a television that refuses
  // everything still produced a complete report, and that report is the point.
  return 0;
}
