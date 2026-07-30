import { Agent, runDiagnostics, reportToMarkdown, type LlmClient } from "@tv-ai-agent/core";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import {
  mountAgentOverlay, mountAgentCanvas, createConfirmHandler, speakReplies,
} from "@tv-ai-agent/ui";
import {
  createScriptedClient, createOpenAiCompatibleClient, resolveLlmEndpoint,
} from "@tv-ai-agent/llm-connectors";
import { createWeatherTool } from "@tv-ai-agent/skills-example";
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
  if (/(^|[?&])diag/.test(location.search)) {
    const report = await runDiagnostics(platform, { allowWrites: location.search.includes("writes") });
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
  const params = new URLSearchParams(location.search);
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
  const skills: Tool[] = /(^|[?&])skills=(weather|all)/.test(location.search)
    ? [createWeatherTool() as Tool]
    : [];

  const agent = new Agent({
    platform,
    llm,
    tools: skills,
    // Demonstrate the confirmation gate: confirm-required tools (launch app,
    // switch input) prompt before running. Same handler the device hosts use.
    confirm: createConfirmHandler(),
  });
  // ?render=canvas uses the single-surface canvas renderer instead of the DOM overlay.
  const ui = params.get("render") === "canvas"
    ? mountAgentCanvas(agent, { width: window.innerWidth, height: Math.round(window.innerHeight * 0.45) })
    : mountAgentOverlay(agent);

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
  function appendLog(who: string, text: string, opacity: number) {
    if (!log) return;
    const line = document.createElement("div");
    line.style.opacity = String(opacity);
    line.textContent = `${who}: ${text}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  // Optional voice: speak replies and accept spoken commands when supported.
  speakReplies(agent, platform);
  if (platform.has("voice") && platform.voice) {
    const voice = platform.voice;
    const mic = document.getElementById("mic") as HTMLButtonElement | null;
    let listening = false;
    async function startCapture(): Promise<void> {
      if (listening) return;
      listening = true;
      if (mic) mic.textContent = "● Listening…";
      try { await voice.startListening(); }
      catch { listening = false; if (mic) mic.textContent = "🎤 Speak"; }
    }
    if (mic) {
      mic.hidden = false;
      voice.onTranscript((text, isFinal) => {
        if (input) input.value = text;
        if (isFinal) { listening = false; mic.textContent = "🎤 Speak"; void ui.ask(text); }
      });
      mic.addEventListener("click", async () => {
        if (listening) { await voice.stopListening(); listening = false; mic.textContent = "🎤 Speak"; return; }
        await startCapture();
      });
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
      await ui.ask(value);
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
