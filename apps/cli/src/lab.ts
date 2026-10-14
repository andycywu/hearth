/**
 * `hearth lab` — a small local web app for testing the Pi's interfaces by hand:
 * send any CEC command and see what the bus did, record the microphone and read
 * its level, speak through the speaker.
 *
 * It exists because "the TV does not respond" was four different problems that
 * looked identical from outside (see `adapter-linux/src/lab-cec.ts`). The page is
 * served from the Pi and shown on the Pi's own desktop, so the thing under test
 * and the thing showing the result are one box.
 *
 * It controls a television, so it is not open: every request needs the random
 * token printed at start-up, and unless `--listen lan` is given it answers only
 * on 127.0.0.1 and refuses a Host header that is not the loopback (a web page in
 * another tab can otherwise reach a local port by DNS rebinding).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  CEC_COMMANDS, createAudioLab, createLinuxCecTransport, diagnoseCec, findCommand, labContext, readAdapter,
  listTtsVoices, readRingState, ringStateForCec, ringStateForDiagnosis, runCecCommand, runCecRaw, systemSpawner, TTS_VARIANTS,
  validateTtsChoice,
  type AudioLab, type CecContext, type RingState, type RingStateRecord, type Spawner, type StatusRing, type TtsVoice,
} from "@hearthkit/adapter-linux";
import { loadConfig, saveConfig, type HearthConfig } from "./config.js";
import { AVATAR_IDS, isAvatarId } from "./lab-avatars.js";
import type { CecTransport } from "@hearthkit/adapter-cec";
import { LAB_PAGE } from "./lab-page.js";

export interface LabOptions {
  device?: string;
  audioDevice?: string;
  token?: string;
  /** Answer on the LAN as well; the token is then the only thing keeping a neighbour out. */
  lan?: boolean;
  /** Substituted in tests. */
  cec?: CecContext;
  audio?: AudioLab;
  spawn?: Spawner;
  transport?: () => CecTransport;
  throttled?: () => Promise<string | undefined>;
  /** The status ring: it moves while a command is on the bus and shows the answer, so the room can see the lab work. */
  ring?: StatusRing | undefined;
  /** Where the avatar and the voice are remembered: the Hearth config file. Substituted in tests. */
  settings?: { load(): Promise<HearthConfig>; save(config: HearthConfig): Promise<void> };
  /** What the ring is showing in whichever process owns it. Substituted in tests. */
  ringState?: () => Promise<RingStateRecord>;
  /** The voices espeak-ng offers. Substituted in tests. */
  voices?: () => Promise<TtsVoice[]>;
  /** How often the ring-state stream looks at the state file. Default 300 ms. */
  pollMs?: number;
}

export interface Lab {
  server: Server;
  token: string;
  /** Resolves to the port once listening. */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024;

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export function createLab(o: LabOptions = {}): Lab {
  const device = o.device ?? "/dev/cec0";
  const token = o.token ?? randomBytes(16).toString("hex");
  const cec = o.cec ?? labContext(device);
  const audio = o.audio ?? createAudioLab({ device: o.audioDevice ?? "default" });
  const spawn = o.spawn ?? systemSpawner;
  const transport = o.transport ?? (() => createLinuxCecTransport({ device, run: cec.run }));
  const throttled = o.throttled ?? (async () => {
    const r = await cec.run("vcgencmd", ["get_throttled"]).catch(() => undefined);
    return r && r.code === 0 ? /throttled=(0x[0-9a-f]+)/i.exec(r.stdout)?.[1] : undefined;
  });
  let monitor: ReturnType<Spawner> | undefined;
  let port = 0;
  let voices: TtsVoice[] | undefined;
  const settings = o.settings ?? { load: () => loadConfig(), save: (c: HearthConfig) => saveConfig(c) };
  // A ring that cannot be written must never fail a CEC command: it is a courtesy.
  const lit = (state: RingState): Promise<void> => (o.ring ? o.ring.show(state).catch(() => {}) : Promise.resolve());

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://lab.invalid");
    const host = (req.headers.host ?? "").toLowerCase();
    if (!o.lan && !(host === `127.0.0.1:${port}` || host === `localhost:${port}`)) {
      return send(res, 403, { error: "this lab answers on 127.0.0.1 only; use --listen lan to open it to the network" });
    }
    if (url.searchParams.get("t") !== token) {
      return send(res, 403, { error: "missing or wrong token — open the address `hearth lab` printed" });
    }

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, LAB_PAGE, "text/html");

    if (req.method === "GET" && url.pathname === "/api/state") {
      const adapter = await readAdapter(cec);
      return send(res, 200, {
        device, adapter: { physical: adapter.physical ?? null, logical: adapter.logical }, throttled: (await throttled()) ?? null,
        commands: CEC_COMMANDS.map(({ id, label, group, changesState, explain }) => ({ id, label, group, changesState, explain })),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/audio/last.wav") {
      const wav = audio.last();
      if (!wav) return send(res, 404, { error: "nothing recorded yet" });
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "cache-control": "no-store" });
      return void res.end(Buffer.from(wav));
    }

    if (req.method === "GET" && url.pathname === "/api/monitor") return startMonitor(req, res);

    if (req.method === "GET" && url.pathname === "/api/voices") {
      try {
        voices ??= await (o.voices ?? (() => listTtsVoices(cec.run)))();
        return send(res, 200, { voices, variants: TTS_VARIANTS });
      } catch (err) {
        return send(res, 200, { voices: [], variants: TTS_VARIANTS, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/settings") return send(res, 200, await settingsView());
    if (req.method === "GET" && url.pathname === "/api/ring-state") return send(res, 200, await readState());
    if (req.method === "GET" && url.pathname === "/api/ring-stream") return startRingStream(req, res);

    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const body = await readJson(req);

    switch (url.pathname) {
      case "/api/run": {
        const def = typeof body.id === "string" ? findCommand(body.id) : undefined;
        if (!def) return send(res, 400, { error: `unknown command "${String(body.id)}"` });
        const target = Number(body.target ?? 0);
        if (!Number.isInteger(target) || target < 0 || target > 14) return send(res, 400, { error: "target must be a logical address 0–14" });
        await lit("acting");
        const result = await runCecCommand(cec, def, { target });
        await lit(ringStateForCec(result));
        return send(res, 200, result);
      }
      case "/api/raw": {
        const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === "string") : [];
        await lit("acting");
        const result = await runCecRaw(cec, args);
        await lit(ringStateForCec(result));
        return send(res, 200, result);
      }
      case "/api/diagnose":
        await lit("acting");
        const diagnosis = await diagnoseCec(cec);
        await lit(ringStateForDiagnosis(diagnosis));
        return send(res, 200, diagnosis);
      case "/api/hearth-view": {
        const t = transport();
        await lit("acting");
        try {
          const devices = await t.scan();
          const tv = await t.powerStatus(0).catch((e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`);
          await lit("verified");
          return send(res, 200, {
            ok: true,
            summary: devices.length
              ? `Hearth's transport found ${devices.length} device(s) on the bus. The TV (address 0) reports power: ${tv}.`
              : `Hearth's transport found no devices past this box. The TV (address 0) reports power: ${tv}. (Hearth lists devices behind the TV; the TV itself is answered by the power query.)`,
            devices: devices.map((d) => JSON.stringify(d)),
          });
        } catch (err) {
          await lit("failed");
          return send(res, 200, { ok: false, summary: `Hearth's transport failed: ${err instanceof Error ? err.message : String(err)}`, devices: [] });
        }
      }
      case "/api/audio/record":
        await lit("hearing");                      // the microphone is open: the ring breathes
        const rec = await audio.record(Number(body.seconds ?? 4));
        await lit(rec.ok ? "listening" : "failed");
        return send(res, 200, rec);
      case "/api/audio/play":
        await lit("speaking");
        const played = await audio.play();
        await lit(played.ok ? "listening" : "failed");
        return send(res, 200, played);
      case "/api/settings": {
        const config = await settings.load();
        if (body.avatar !== undefined) {
          if (!isAvatarId(body.avatar)) return send(res, 400, { error: `unknown avatar "${String(body.avatar)}"` });
          config.avatar = body.avatar;
        }
        if (body.tts !== undefined) {
          const checked = validateTtsChoice(body.tts);
          if (!checked.ok) return send(res, 400, { error: checked.error });
          const c = checked.choice;
          // An empty choice is "back to the default": the keys are removed, not set to nothing.
          if (c.voice) config.ttsVoice = c.voice; else delete config.ttsVoice;
          if (c.speed !== undefined) config.ttsSpeed = c.speed; else delete config.ttsSpeed;
          if (c.pitch !== undefined) config.ttsPitch = c.pitch; else delete config.ttsPitch;
        }
        await settings.save(config);
        return send(res, 200, await settingsView());
      }
      case "/api/audio/say":
        await lit("speaking");
        const said = await audio.say(String(body.text ?? ""), { voice: body.voice, speed: body.speed, pitch: body.pitch });
        await lit(said.ok ? "listening" : "failed");
        return send(res, 200, said);
      default:
        return send(res, 404, { error: "not found" });
    }
  }

  async function settingsView(): Promise<Record<string, unknown>> {
    const c = await settings.load();
    return {
      avatar: isAvatarId(c.avatar) ? c.avatar : "orb",
      avatars: AVATAR_IDS,
      tts: { voice: c.ttsVoice ?? null, speed: c.ttsSpeed ?? null, pitch: c.ttsPitch ?? null },
    };
  }

  /** What the ring is showing now, in whichever Hearth process owns it. */
  const readState = (): Promise<RingStateRecord> => (o.ringState ?? (() => readRingState()))();

  /**
   * The ring's state as a stream, so the avatar in the window is the real thing's face: hearing when the box
   * hears, thinking when it thinks. Polls the small state file the ring writes; sends only changes.
   */
  function startRingStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    let last = "";
    const look = async (): Promise<void> => {
      const r = await readState().catch(() => undefined);
      if (!r || r.state === last) return;
      last = r.state;
      res.write(`data: ${JSON.stringify(r)}\n\n`);
    };
    void look();
    const timer = setInterval(() => { void look(); }, o.pollMs ?? 300);
    timer.unref();
    req.on("close", () => clearInterval(timer));
  }

  function startMonitor(req: IncomingMessage, res: ServerResponse): void {
    if (monitor) { monitor.kill(); monitor = undefined; }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    let proc = spawn("cec-ctl", ["-d", device, "--monitor"]);
    let escalated = false;
    monitor = proc;
    const write = (event: string | undefined, data: string): void => { res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`); };
    const heartbeat = setInterval(() => res.write(": still here\n\n"), 15_000);
    const done = (): void => { clearInterval(heartbeat); proc.kill(); if (monitor === proc) monitor = undefined; };
    req.on("close", done);

    void (async () => {
      for (;;) {
        let pending = "";
        let seen = "";
        try {
          for await (const chunk of proc.stdout) {
            const text = Buffer.from(chunk).toString("utf8");
            seen += text;
            pending += text;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) if (line.trim()) write(undefined, line.replace(/\s+$/, ""));
          }
        } catch { /* the process ended under us */ }
        const code = await proc.exit;
        // Monitor mode is root-only in the kernel. Try `sudo -n` once (passive, fixed arguments); if that
        // wants a password, say what to type instead of failing in silence.
        if (!escalated && /run this as root|monitor mode failed/i.test(`${seen}${proc.stderr()}`)) {
          escalated = true;
          write("fault", "monitor mode needs root; trying sudo -n …");
          proc = spawn("sudo", ["-n", "cec-ctl", "-d", device, "--monitor"]);
          monitor = proc;
          continue;
        }
        const why = proc.stderr().trim().split("\n")[0] ?? "";
        write("fault", /password is required|terminal is required/i.test(why)
          ? `monitor mode needs root and sudo wants a password. In a terminal on the Pi run: sudo cec-ctl -d ${device} --monitor`
          : `cec-ctl --monitor ended (exit ${code ?? "none"})${why ? `: ${why}` : ""}`);
        break;
      }
      clearInterval(heartbeat);
      res.end();
    })();
  }

  return {
    server, token,
    listen: (p) => new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, o.lan ? "0.0.0.0" : "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve(port);
      });
    }),
    close: () => new Promise<void>((resolve) => {
      monitor?.kill();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/** A `.desktop` entry that opens the lab in its own window from the Pi's menu or desktop. */
export function launcherEntry(o: { node: string; cli: string }): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Hearth Lab",
    "Comment=Send CEC commands and test the microphone and speaker",
    "Icon=utilities-terminal",
    `Exec=${o.node} ${o.cli} lab`,
    "Terminal=false",
    "Categories=Utility;",
    "",
  ].join("\n");
}
