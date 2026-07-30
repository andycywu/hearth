import { Agent, runDiagnostics, reportToMarkdown } from "@tv-ai-agent/core";
import { createAospAdapter } from "@tv-ai-agent/adapter-aosp";
import { createOpenAiCompatibleClient } from "@tv-ai-agent/llm-connectors";
import { createConfirmHandler, speakReplies } from "@tv-ai-agent/ui";

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

  // Bring-up mode: load with `?diag` to render an on-screen capability report.
  if (typeof location !== "undefined" && /(^|[?&])diag/.test(location.search)) {
    const report = await runDiagnostics(platform, { allowWrites: location.search.includes("writes") });
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:24px;color:#e8eefc;white-space:pre-wrap;text-align:left";
    pre.textContent = reportToMarkdown(report) + "\nsummary: " + JSON.stringify(report.summary);
    document.body.innerHTML = "";
    document.body.appendChild(pre);
    return;
  }

  const llm = createOpenAiCompatibleClient({
    baseUrl: window.__AGENT_LLM_BASE_URL__ ?? "http://127.0.0.1:8080/v1",
    model: window.__AGENT_LLM_MODEL__ ?? "local-tv-agent",
  });

  // Parity with the dev harness: gate the high-impact tools and speak replies
  // when the device has a voice pipeline.
  const agent = new Agent({ platform, llm, confirm: createConfirmHandler() });
  speakReplies(agent, platform);
  window.__tvAgent = agent;
  console.info(`[aosp] agent ready on ${platform.device.model} (${platform.device.soc})`);
}
boot();
