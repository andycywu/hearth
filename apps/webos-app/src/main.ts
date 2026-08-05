import { Agent, runDiagnostics, reportToMarkdown, launchSearch } from "@tv-ai-agent/core";
import { createWebosAdapter } from "@tv-ai-agent/adapter-webos";
import { createOpenAiCompatibleClient, createScriptedClient, resolveLlmEndpoint } from "@tv-ai-agent/llm-connectors";
import {
  createConfirmHandler, confirmOverrideFromUrl, runStartupCommands, mountDeviceShell, speakReplies,
  keyboardOption, renderOption, applyTvTheme, tvThemeOptionsFromUrl,
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

    // The shared look, before anything is drawn: it makes the window itself
    // transparent, so the agent sits over whatever was on screen. `?solid`
    // turns that off for a bring-up capture, `?scrim=` tunes how much of the
    // content behind stays visible.
    applyTvTheme(tvThemeOptionsFromUrl(launchSearch()));

    // Bring-up mode: open with `?diag` to render a capability report.
    if (/(^|[?&])diag/.test(launchSearch())) {
      const report = await runDiagnostics(platform, { allowWrites: launchSearch().includes("writes") });
      const markdown = reportToMarkdown(report) + "\nsummary: " + JSON.stringify(report.summary);
      // Console too, so `ares-inspect` gives you copyable text (no OCR).
      console.info(markdown);
      const app = document.getElementById("app");
      if (app) {
        const pre = document.createElement("pre");
        pre.style.cssText = "padding:24px;font-size:20px;white-space:pre-wrap;text-align:left";
        pre.textContent = markdown;
        // Opaque for the report: it is read, not glanced at.
        applyTvTheme({ translucent: false });
        app.innerHTML = "";
        app.appendChild(pre);
      }
      return;
    }

    // ?llm=/?model= → window globals, so a packaged .ipk can be repointed at
    // another endpoint without a rebuild. No default: with nothing configured,
    // fall back to the offline brain already in this bundle rather than to a
    // dead address, so `?demo` runs on a TV with no network set up yet.
    const endpoint = resolveLlmEndpoint();
    const llm = endpoint.baseUrl
      ? createOpenAiCompatibleClient({
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
        })
      : createScriptedClient();

    // Parity with the dev harness: gate the high-impact tools and speak replies
    // when the device has a voice pipeline.
    const confirm = confirmOverrideFromUrl() ?? createConfirmHandler();
    const agent = new Agent({ platform, llm, confirm });
    window.__tvAgent = agent;
    window.__tvPlatform = platform;

    const ui = mountDeviceShell(agent, platform, {
      detail: `llm=${endpoint.baseUrl ?? "offline"}`,
      // The avatar is the default face; `?render=overlay` is the plain
      // bring-up view. `?keyboard` adds the remote-driven on-screen keyboard,
      // so a TV can type rather than being limited to whatever was baked into
      // the launch flags.
      ...renderOption(),
      ...keyboardOption(),
    });
    // After the shell exists, so the avatar can be told when it's speaking.
    speakReplies(agent, platform, { onSpeaking: (s) => ui.setSpeaking?.(s) });
    // `?demo` runs the built-in script, `?ask=…` runs your own.
    await runStartupCommands(ui);
  } catch (e) {
    if (status) status.textContent = "Boot error: " + (e as Error).message;
  }
}

boot();
