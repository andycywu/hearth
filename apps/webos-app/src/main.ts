import { Agent, runDiagnostics, reportToMarkdown } from "@tv-ai-agent/core";
import { createWebosAdapter } from "@tv-ai-agent/adapter-webos";
import { createOpenAiCompatibleClient, resolveLlmEndpoint } from "@tv-ai-agent/llm-connectors";
import {
  createConfirmHandler, confirmOverrideFromUrl, commandsFromUrl, mountDeviceShell, speakReplies,
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
    // The Luna bridge lives in LG's webOSTV.js, which this repo doesn't ship.
    // Say so plainly instead of failing later with "webOS is not defined".
    if ((window as unknown as Record<string, unknown>).__WEBOSTV_MISSING__) {
      throw new Error(
        "webOSTV.js is missing — drop LG's library in as webOSTVjs/webOSTV.js " +
        "before packaging (see apps/webos-app/README.md)",
      );
    }
    const platform = createWebosAdapter();
    await platform.init();

    // Bring-up mode: open with `?diag` to render a capability report.
    if (typeof location !== "undefined" && /(^|[?&])diag/.test(location.search)) {
      const report = await runDiagnostics(platform, { allowWrites: location.search.includes("writes") });
      const markdown = reportToMarkdown(report) + "\nsummary: " + JSON.stringify(report.summary);
      // Console too, so `ares-inspect` gives you copyable text (no OCR).
      console.info(markdown);
      const app = document.getElementById("app");
      if (app) {
        const pre = document.createElement("pre");
        pre.style.cssText = "padding:24px;font-size:20px;white-space:pre-wrap;text-align:left";
        pre.textContent = markdown;
        app.innerHTML = "";
        app.appendChild(pre);
      }
      return;
    }

    // ?llm=/?model= → window globals → default, so a packaged .ipk can be
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
    window.__tvAgent = agent;
    window.__tvPlatform = platform;

    const ui = mountDeviceShell(agent, platform, { detail: `llm=${endpoint.baseUrl}` });
    // `?ask=…` (repeatable) drives the agent without a keyboard.
    for (const command of commandsFromUrl()) await ui.ask(command);
  } catch (e) {
    if (status) status.textContent = "Boot error: " + (e as Error).message;
  }
}

boot();
