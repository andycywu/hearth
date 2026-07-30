import { Agent, runDiagnostics, reportToMarkdown } from "@tv-ai-agent/core";
import { createTizenAdapter } from "@tv-ai-agent/adapter-tizen";
import { createOpenAiCompatibleClient, resolveLlmEndpoint } from "@tv-ai-agent/llm-connectors";
import { createConfirmHandler, confirmOverrideFromUrl, speakReplies } from "@tv-ai-agent/ui";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";

declare global {
  interface Window {
    __AGENT_LLM_BASE_URL__?: string;
    __AGENT_LLM_MODEL__?: string;
    __tvAgent?: Agent;
    /** Exposed for bring-up: lets a device run assert real device state. */
    __tvPlatform?: PlatformProvider;
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

    // ?llm=/?model= → window globals → default, so a packaged .wgt can be
    // repointed at another endpoint without a rebuild.
    const endpoint = resolveLlmEndpoint({ defaultBaseUrl: "http://127.0.0.1:8080/v1" });
    const llm = createOpenAiCompatibleClient({
      baseUrl: endpoint.baseUrl!,
      model: endpoint.model,
      ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
    });

    // Parity with the dev harness: gate the high-impact tools and speak replies
    // when the device has a voice pipeline.
    const confirm = confirmOverrideFromUrl() ?? createConfirmHandler();
    const agent = new Agent({ platform, llm, confirm });
    speakReplies(agent, platform);
    window.__tvAgent = agent; // UI shell attaches here
    window.__tvPlatform = platform;
    if (status) {
      status.textContent =
        `Ready on ${platform.device.model} (${platform.device.soc}) · llm=${endpoint.baseUrl}`;
    }
  } catch (e) {
    if (status) status.textContent = "Boot error: " + (e as Error).message;
  }
}

function renderDiagnostics(report: Awaited<ReturnType<typeof runDiagnostics>>): void {
  const markdown = reportToMarkdown(report) + "\nsummary: " + JSON.stringify(report.summary);
  // Console too, so the Web Inspector gives you copyable text (no OCR).
  console.info(markdown);
  const app = document.getElementById("app");
  if (!app) return;
  const pre = document.createElement("pre");
  pre.style.cssText = "padding:24px;font-size:20px;white-space:pre-wrap;text-align:left";
  pre.textContent = markdown;
  app.innerHTML = "";
  app.appendChild(pre);
}

boot();
