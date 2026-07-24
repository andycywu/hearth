import { Agent } from "@tv-ai-agent/core";
import { createTizenAdapter } from "@tv-ai-agent/adapter-tizen";
import { createOpenAiCompatibleClient } from "@tv-ai-agent/llm-connectors";

declare global {
  interface Window {
    __AGENT_LLM_BASE_URL__?: string;
    __AGENT_LLM_MODEL__?: string;
    __tvAgent?: Agent;
  }
}

async function boot(): Promise<void> {
  const status = document.getElementById("status");
  try {
    const platform = createTizenAdapter();
    await platform.init();

    const llm = createOpenAiCompatibleClient({
      baseUrl: window.__AGENT_LLM_BASE_URL__ ?? "http://127.0.0.1:8080/v1",
      model: window.__AGENT_LLM_MODEL__ ?? "local-tv-agent",
    });

    const agent = new Agent({ platform, llm });
    window.__tvAgent = agent; // UI shell / voice pipeline attach here
    if (status) status.textContent = `Ready on ${platform.device.model} (${platform.device.soc})`;
  } catch (e) {
    if (status) status.textContent = "Boot error: " + (e as Error).message;
  }
}
boot();
