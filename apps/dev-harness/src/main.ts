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

  // Real endpoint if configured, otherwise the offline scripted brain.
  const llm: LlmClient = window.__AGENT_LLM_BASE_URL__
    ? createOpenAiCompatibleClient({
        baseUrl: window.__AGENT_LLM_BASE_URL__,
        model: window.__AGENT_LLM_MODEL__ ?? "local-tv-agent",
        apiKey: window.__AGENT_LLM_API_KEY__,
      })
    : createScriptedClient();

  const agent = new Agent({ platform, llm });
  const ui = mountAgentOverlay(agent);

  if (state) {
    state.textContent = `ready · ${platform.device.model} · llm=${llm.id} · volume=${await platform.system.getVolume()}`;
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
