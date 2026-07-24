import { Agent, runDiagnostics, reportToMarkdown } from "@tv-ai-agent/core";
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

    // Bring-up mode: open the app with `?diag` to render a capability report.
    if (typeof location !== "undefined" && /(^|[?&])diag/.test(location.search)) {
      const report = await runDiagnostics(platform, { allowWrites: location.search.includes("writes") });
      renderDiagnostics(report);
      return;
    }

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

function renderDiagnostics(report: Awaited<ReturnType<typeof runDiagnostics>>): void {
  const app = document.getElementById("app");
  if (!app) return;
  const pre = document.createElement("pre");
  pre.style.cssText = "padding:24px;font-size:20px;white-space:pre-wrap;text-align:left";
  pre.textContent = reportToMarkdown(report) + "\nsummary: " + JSON.stringify(report.summary);
  app.innerHTML = "";
  app.appendChild(pre);
}

boot();
