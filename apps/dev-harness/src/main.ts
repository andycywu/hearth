import {
  Agent, runDiagnostics, reportToMarkdown, launchSearch, summarizeOutcome,
  discoverRoom, deviceTreeText, CapabilityGraph, WorldModel, capabilitiesForPlatform,
  type LlmClient,
} from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import {
  mountAgentOverlay, mountAgentCanvas, mountAgentAvatar, createConfirmHandler, speakReplies,
  createListeningState,
} from "@hearthkit/ui";
import {
  createScriptedClient, createOpenAiCompatibleClient, resolveLlmEndpoint,
} from "@hearthkit/llm-connectors";
import { createWeatherTool } from "@hearthkit/skills-example";
import { createScriptedSource, occupancyScript } from "@hearthkit/perception-mock";
import {
  createModelPilotClient, createModelPilotPlanner, resolveModelPilotConfig, offReason,
} from "@hearthkit/modelpilot";
import { loadBundledSkills, loadInstalledSkills } from "@hearthkit/skill-manifest";
import weatherManifest from "@hearthkit/skill-manifest/examples/open-meteo-weather.json";
import type { Tool } from "@hearthkit/core";

declare global {
  interface Window {
    __MODELPILOT_API_KEY__?: string;
    __MODELPILOT_BASE_URL__?: string;
    __AGENT_LLM_BASE_URL__?: string;
    __AGENT_LLM_MODEL__?: string;
    __AGENT_LLM_API_KEY__?: string;
  }
}

/**
 * The capability graph a planner reasons over, built the same way the agent
 * builds its own. Two graphs is a smell — the agent owns the authoritative one
 * and withdraws from it — so this is only for wiring a planner that has to exist
 * *before* the agent does.
 */
function capabilityGraphFor(platform: Parameters<typeof capabilitiesForPlatform>[0]): CapabilityGraph {
  const graph = new CapabilityGraph();
  graph.registerAll(capabilitiesForPlatform(platform));
  return graph;
}

async function boot(): Promise<void> {
  const state = document.getElementById("state");
  const input = document.getElementById("cmd") as HTMLInputElement | null;

  const platform = createWebAdapter();
  await platform.init();

  // `?diag` renders the on-device capability report (same probe as the device
  // builds) instead of the chat UI.
  if (/(^|[?&])diag/.test(launchSearch())) {
    const report = await runDiagnostics(platform, { allowWrites: launchSearch().includes("writes") });
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:24px;white-space:pre-wrap;font-size:15px;line-height:1.5";
    pre.textContent = reportToMarkdown(report) + "\nsummary: " + JSON.stringify(report.summary);
    document.body.appendChild(pre);
    if (input) input.hidden = true;
    if (state) state.hidden = true;
    return;
  }

  // Endpoint config precedence: URL query (?llm=…&model=…) > window globals >
  // offline scripted brain. The query form lets you point at a local model with
  // no code edit, e.g. ?llm=http://127.0.0.1:11434/v1&model=llama3.2
  // Same resolver the device hosts use — no default here, so with nothing
  // configured we fall back to the offline brain instead of a dead endpoint.
  const params = new URLSearchParams(launchSearch());
  const endpoint = resolveLlmEndpoint();

  const llm: LlmClient = endpoint.baseUrl
    ? createOpenAiCompatibleClient({
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
      })
    : createScriptedClient();

  // `?skills=weather` registers the example cross-vendor skill (docs/skills.md).
  // Opt-in because it talks to the network, which the offline demo otherwise
  // never does. Then try: "what's the weather in Taipei?"
  const requested = params.get("skills") ?? "";
  const skills: Tool[] = /^(weather|all)$/.test(requested) ? [createWeatherTool() as Tool] : [];

  // The same capability again, but declared rather than written — `?skills=manifest`
  // loads the example JSON through the manifest runtime (docs/skills.md). The
  // allowlist lives here, in the host, because a manifest must not widen its own
  // reach; anything installed into storage is held to the same list.
  const allowOrigins = ["https://api.open-meteo.com", "loopback"];
  if (/^(manifest|all)$/.test(requested)) {
    skills.push(...await loadBundledSkills([weatherManifest], { allowOrigins, onSkipped: warnSkipped }));
  }
  skills.push(...await loadInstalledSkills(platform.storage, { allowOrigins, onSkipped: warnSkipped }));

  // One unusable skill must not stop the agent from starting — say so and go on.
  function warnSkipped(name: string, reason: string): void {
    console.warn(`[skills] skipping ${name}: ${reason}`);
  }

  // The room: stored registrations, what the TV itself can see, and — only when
  // nothing is stored — a demo living room so the goal-based scenarios have
  // something to reason about. `?room=empty` to watch the agent say it does not
  // know where anything is. Shared with the device hosts, because four slightly
  // different copies of this is how an emulator ends up with a room a TV does not
  // have.
  const devices = await discoverRoom(platform, { room: params.get("room") === "empty" ? "empty" : "demo" });

  // `?devices` prints the room the same way `?diag` prints the capabilities.
  if (params.has("devices")) {
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:24px;white-space:pre-wrap;font-size:15px;line-height:1.5";
    pre.textContent = deviceTreeText(devices);
    document.body.appendChild(pre);
    if (input) input.hidden = true;
    if (state) state.hidden = true;
    return;
  }

  // One world, shared by the agent and by whatever plans for it: a planner that
  // reasoned about a different room than the executor acts on would be a bug
  // nobody could see.
  const sharedWorld = new WorldModel();

  // ModelPilot, when a key has been configured. Off otherwise — a television
  // that quietly tries to reach a cloud endpoint it has no credential for is
  // both noisy and wrong, so configuring the key is the act that opts in.
  //
  // `?modelpilot=shadow|enforce|off` picks the mode without a rebuild. The key
  // is never read from the URL: set `window.__MODELPILOT_API_KEY__` before the
  // bundle loads, which for the dev harness means a line in the console or in
  // index.html.
  const mpConfig = resolveModelPilotConfig({
    search: launchSearch(),
    globals: window as unknown as Record<string, unknown>,
  });
  const planner = mpConfig.apiKey
    ? createModelPilotPlanner({
        client: createModelPilotClient({
          baseUrl: mpConfig.baseUrl,
          apiKey: mpConfig.apiKey,
          timeoutMs: mpConfig.timeoutMs,
        }),
        mode: mpConfig.mode,
        graph: capabilityGraphFor(platform),
        world: sharedWorld,
        devices,
        maxTaskBudget: mpConfig.maxTaskBudget,
        // Telemetry to the console here; a device host would persist it. Never
        // the key, never the prompt, never the room state — the record type and
        // `sanitizeTelemetry` both see to that.
        telemetry: (record) => console.info("[modelpilot]", JSON.stringify(record)),
      })
    : undefined;
  console.info(
    `[modelpilot] mode=${mpConfig.mode} (${mpConfig.source})`
    + (planner ? ` endpoint=${mpConfig.baseUrl}` : ` — ${offReason({ search: launchSearch(), globals: window as unknown as Record<string, unknown> }) ?? "off"}`),
  );

  const agent = new Agent({
    platform,
    llm,
    tools: skills,
    devices,
    world: sharedWorld,
    ...(planner ? { planner, llmPlanning: true } : {}),
    // `?plan=llm` lets the model plan the goals no skill covers. Off by default:
    // the deterministic planner is faster, offline and predictable, and it goes
    // first either way.
    ...(params.get("plan") === "llm" ? { llmPlanning: true } : {}),
    // Demonstrate the confirmation gate: confirm-required tools (launch app,
    // switch input) prompt before running. Same handler the device hosts use.
    confirm: createConfirmHandler(),
  });
  // ?render=canvas uses the single-surface canvas renderer instead of the DOM
  // overlay; ?render=avatar draws the agent's face on the same canvas path.
  const renderer = params.get("render");
  const surface = { width: window.innerWidth, height: Math.round(window.innerHeight * 0.45) };
  const avatar = renderer === "avatar" ? mountAgentAvatar(agent, surface) : undefined;
  const ui = avatar
    ?? (renderer === "canvas" ? mountAgentCanvas(agent, surface) : mountAgentOverlay(agent));

  // Scrolling transcript of the session.
  const log = document.getElementById("log");
  let pending = "";
  agent.events.on("turn:start", ({ input: text }) => { pending = text; });
  agent.events.on("tool:call", ({ name, args }) => appendLog("·", `${name}(${JSON.stringify(args)})`, 0.5));
  agent.events.on("turn:end", ({ output }) => {
    if (pending) appendLog("You", pending, 0.85);
    appendLog("Agent", output, 1);
    pending = "";
  });
  agent.events.on("plan:step", ({ outcome }) =>
    appendLog("·", `${outcome.step.action.capabilityId} — ${outcome.status}`, 0.5));
  agent.events.on("plan:end", ({ outcome }) => {
    if (pending) appendLog("You", pending, 0.85);
    appendLog("Agent", summarizeOutcome(outcome), 1);
    pending = "";
  });

  function appendLog(who: string, text: string, opacity: number): void {
    if (!log) return;
    const line = document.createElement("div");
    line.style.opacity = String(opacity);
    line.textContent = `${who}: ${text}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  /**
   * The two paths, and the agent decides which. A goal it can plan is planned,
   * verified and reported; everything else is a conversation, exactly as before.
   * `?plan=off` forces the chat path, which is how you see the difference: ask for
   * HDMI2 both ways and watch only one of them check whether it worked.
   */
  const planMode = params.get("plan") !== "off";
  async function ask(text: string): Promise<void> {
    if (planMode) {
      pending = text;
      const outcome = await agent.pursueIntent(text);
      if (outcome) return;
      pending = "";
    }
    await ui.ask(text);
  }

  // `?perception=mock` registers a scripted occupancy source — no camera, no CV
  // model, no `mediaDevices`. It has to be *granted* before it starts, through the
  // same confirmation dialog a gated tool uses, and the indicator below is not
  // optional decoration: a sensor that is live must be visibly live.
  if (params.get("perception") === "mock") {
    const camera = createScriptedSource({
      script: occupancyScript(),
      intervalMs: 4000,
      repeat: true,
    });
    agent.perception.register(camera);

    const indicator = document.createElement("div");
    indicator.style.cssText = "position:fixed;top:8px;right:12px;font-size:14px;opacity:.85";
    document.body.appendChild(indicator);
    agent.events.on("perception:grant", ({ grant }) => {
      indicator.textContent = grant ? "● sensing the room" : "";
    });
    agent.events.on("perception:event", ({ event }) =>
      appendLog("○", `${event.type} ${JSON.stringify(event.value)}`, 0.45));

    const started = await agent.perception.start(camera.id);
    if (!started.started) console.info(`[perception] not started: ${started.reason}`);
  }

  // Optional voice: speak replies and accept spoken commands when supported.
  // The avatar needs to know about both, since the agent doesn't.
  speakReplies(agent, platform, { onSpeaking: (s) => avatar?.setSpeaking(s) });
  if (platform.has("voice") && platform.voice) {
    const voice = platform.voice;
    const mic = document.getElementById("mic") as HTMLButtonElement | null;
    // Shared with the device hosts. This used to be a local copy of the same
    // logic, and it had the same defect: only a final transcript cleared the
    // flag, so a no-match or an error left the button reading "Listening…" and
    // every later click doing nothing.
    const capture = createListeningState({
      voice,
      onChange: (on) => {
        if (mic) mic.textContent = on ? "● Listening…" : "🎤 Speak";
        avatar?.setListening(on);
      },
    });
    const startCapture = (): Promise<void> => capture.start();
    if (mic) {
      mic.hidden = false;
      voice.onTranscript((text, isFinal) => {
        if (input) input.value = text;
        if (isFinal) { void capture.stop(); void ask(text); }
      });
      mic.addEventListener("click", () => void capture.toggle());
    }

    // Hands-free wake word ("hey tv") when the pipeline supports it.
    const wake = document.getElementById("wake") as HTMLButtonElement | null;
    if (wake && voice.startWakeWord && voice.stopWakeWord) {
      wake.hidden = false;
      let on = false;
      wake.addEventListener("click", async () => {
        on = !on;
        if (on) {
          wake.textContent = "👂 Listening for “hey tv”";
          await voice.startWakeWord!("hey tv", () => void startCapture());
        } else {
          wake.textContent = "👂 Hands-free";
          await voice.stopWakeWord!();
        }
      });
    }
  }

  if (state) {
    const v = platform.has("voice") ? "voice✓" : "voice✗";
    state.textContent = `ready · ${platform.device.model} · llm=${llm.id} · ${v} · volume=${await platform.system.getVolume()}`;
  }

  input?.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    input.disabled = true;
    try {
      await ask(value);
      if (state) {
        state.textContent =
          `volume=${await platform.system.getVolume()} · muted=${await platform.system.getMute()} · input=${await platform.system.getInputSource()}`;
      }
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
}

boot();
