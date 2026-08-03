import { Agent, runDiagnostics, reportToMarkdown, launchSearch } from "@tv-ai-agent/core";
import { createTizenAdapter } from "@tv-ai-agent/adapter-tizen";
import { createOpenAiCompatibleClient, resolveLlmEndpoint } from "@tv-ai-agent/llm-connectors";
import {
  createConfirmHandler, confirmOverrideFromUrl, runStartupCommands, mountDeviceShell, speakReplies,
} from "@tv-ai-agent/ui";
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

    // ?llm=/?model= → window globals → default, so a packaged .wgt can be
    // repointed at another endpoint without a rebuild.
    const endpoint = resolveLlmEndpoint({ defaultBaseUrl: "http://127.0.0.1:8080/v1" });

    // Bring-up mode: open the app with `?diag` to render a capability report.
    if (/(^|[?&])diag/.test(launchSearch())) {
      const report = await runDiagnostics(platform, {
        allowWrites: launchSearch().includes("writes"),
        // `?diag&reach` also proves the device has a route: its own model
        // endpoint, and a public one to tell "can't reach the host" apart from
        // "no network at all". Opt-in, so a plain ?diag stays offline.
        ...(launchSearch().includes("reach")
          ? { reachUrls: [`${endpoint.baseUrl}/models`, "https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m"] }
          : {}),
      });
      renderDiagnostics(report);
      return;
    }
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
    window.__tvAgent = agent;
    window.__tvPlatform = platform;

    const ui = mountDeviceShell(agent, platform, { detail: `llm=${endpoint.baseUrl}` });
    // `?demo` runs the built-in script, `?ask=…` runs your own.
    await runStartupCommands(ui);
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
