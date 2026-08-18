import {
  Agent, runDiagnostics, reportToMarkdown, launchSearch, summarizeOutcome,
  DeviceGraph, createManualSource, runDiscovery, matchSkill, isPlannable,
  type LlmClient,
} from "@tv-ai-agent/core";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import {
  mountAgentOverlay, mountAgentCanvas, mountAgentAvatar, createConfirmHandler, speakReplies,
  createListeningState,
} from "@tv-ai-agent/ui";
import {
  createScriptedClient, createOpenAiCompatibleClient, resolveLlmEndpoint,
} from "@tv-ai-agent/llm-connectors";
import { createWeatherTool } from "@tv-ai-agent/skills-example";
import { loadBundledSkills, loadInstalledSkills } from "@tv-ai-agent/skill-manifest";
import weatherManifest from "@tv-ai-agent/skill-manifest/examples/open-meteo-weather.json";
import type { Tool } from "@tv-ai-agent/core";

declare global {
  interface Window {
    __AGENT_LLM_BASE_URL__?: string;
    __AGENT_LLM_MODEL__?: string;
    __AGENT_LLM_API_KEY__?: string;
  }
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

  // A demo living room, so the goal-based scenarios have something to reason
  // about. Real hosts get this from discovery (CEC, mDNS) or from what the user
  // registered; here it is declared, which is the point — the planner never
  // learns an HDMI port, it looks one up. `?room=empty` to see what the agent
  // says when it does not know where anything is.
  const devices = new DeviceGraph();
  if (params.get("room") !== "empty") {
    await runDiscovery(devices, [createManualSource([
      { id: "tv", type: "tv", name: "Living Room TV", connection: { kind: "internal" }, source: "manual" },
      { id: "ps5", type: "game_console", name: "PlayStation 5", connection: { kind: "hdmi", port: "hdmi2" }, source: "manual" },
      { id: "stb", type: "stb", name: "Set-top box", connection: { kind: "hdmi", port: "hdmi3" }, source: "manual" },
    ])]);
  }

  const agent = new Agent({
    platform,
    llm,
    tools: skills,
    devices,
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

  /**
   * The two paths. A recognised scenario becomes a goal and gets planned,
   * verified and reported; everything else is a conversation, exactly as before.
   * `?plan=off` forces the chat path, which is how you see the difference: ask
   * for HDMI2 both ways and watch one of them check whether it worked.
   */
  const planMode = params.get("plan") !== "off";
  async function ask(text: string): Promise<void> {
    const match = planMode ? matchSkill(text) : undefined;
    if (match && isPlannable(match)) {
      pending = text;
      await agent.pursueSkill(match.skill, match.params);
      return;
    }
    await ui.ask(text);
  }
  function appendLog(who: string, text: string, opacity: number) {
    if (!log) return;
    const line = document.createElement("div");
    line.style.opacity = String(opacity);
    line.textContent = `${who}: ${text}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
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
