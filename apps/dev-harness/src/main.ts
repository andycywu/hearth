import { Agent, type LlmClient } from "@tv-ai-agent/core";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import { mountAgentOverlay } from "@tv-ai-agent/ui";
import { createScriptedClient, createOpenAiCompatibleClient } from "@tv-ai-agent/llm-connectors";

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

  // Endpoint config precedence: URL query (?llm=…&model=…) > window globals >
  // offline scripted brain. The query form lets you point at a local model with
  // no code edit, e.g. ?llm=http://127.0.0.1:11434/v1&model=llama3.2
  const params = new URLSearchParams(location.search);
  const baseUrl = params.get("llm") ?? window.__AGENT_LLM_BASE_URL__;
  const model = params.get("model") ?? window.__AGENT_LLM_MODEL__ ?? "local-tv-agent";

  const llm: LlmClient = baseUrl
    ? createOpenAiCompatibleClient({ baseUrl, model, apiKey: window.__AGENT_LLM_API_KEY__ })
    : createScriptedClient();

  const agent = new Agent({ platform, llm });
  const ui = mountAgentOverlay(agent);

  // Optional voice: speak replies and accept spoken commands when supported.
  if (platform.has("voice") && platform.voice) {
    const voice = platform.voice;
    agent.events.on("turn:end", ({ output }) => { void voice.speak(output); });
    const mic = document.getElementById("mic") as HTMLButtonElement | null;
    if (mic) {
      mic.hidden = false;
      let listening = false;
      voice.onTranscript((text, isFinal) => {
        if (input) input.value = text;
        if (isFinal) { listening = false; mic.textContent = "🎤 Speak"; void ui.ask(text); }
      });
      mic.addEventListener("click", async () => {
        if (listening) { await voice.stopListening(); listening = false; mic.textContent = "🎤 Speak"; return; }
        listening = true; mic.textContent = "● Listening…";
        try { await voice.startListening(); }
        catch { listening = false; mic.textContent = "🎤 Speak"; }
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
