import { Agent } from "@tv-ai-agent/core";
import { createAospAdapter } from "@tv-ai-agent/adapter-aosp";
import { createOpenAiCompatibleClient } from "@tv-ai-agent/llm-connectors";

declare global {
  interface Window {
    __AGENT_LLM_BASE_URL__?: string;
    __AGENT_LLM_MODEL__?: string;
    __tvAgent?: Agent;
  }
}

async function boot(): Promise<void> {
  const platform = createAospAdapter();
  await platform.init();

  const llm = createOpenAiCompatibleClient({
    baseUrl: window.__AGENT_LLM_BASE_URL__ ?? "http://127.0.0.1:8080/v1",
    model: window.__AGENT_LLM_MODEL__ ?? "local-tv-agent",
  });

  const agent = new Agent({ platform, llm });
  window.__tvAgent = agent;
  console.info(`[aosp] agent ready on ${platform.device.model} (${platform.device.soc})`);
}
boot();
