import { Agent, runDiagnostics, reportToMarkdown, launchSearch } from "@tv-ai-agent/core";
import { createAospAdapter } from "@tv-ai-agent/adapter-aosp";
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
  const platform = createAospAdapter();
  await platform.init();

  // Bring-up mode: load with `?diag` to render an on-screen capability report.
  if (/(^|[?&])diag/.test(launchSearch())) {
    const report = await runDiagnostics(platform, { allowWrites: launchSearch().includes("writes") });
    const markdown = reportToMarkdown(report) + "\nsummary: " + JSON.stringify(report.summary);
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:24px;color:#e8eefc;white-space:pre-wrap;text-align:left";
    pre.textContent = markdown;
    document.body.innerHTML = "";
    document.body.appendChild(pre);
    // Also to the console so bring-up can pull it off the device without OCR:
    // `adb logcat -s chromium:I` (or the Web Inspector on Tizen/webOS).
    console.info(markdown);
    return;
  }

  // Endpoint from ?llm=/?model=, then window globals, then the default — so a
  // shipped APK can be repointed at another model without a rebuild:
  //   adb shell am start -n … -e start "index.html?llm=http://127.0.0.1:8080/v1"
  const endpoint = resolveLlmEndpoint({ defaultBaseUrl: "http://127.0.0.1:8080/v1" });
  const llm = createOpenAiCompatibleClient({
    baseUrl: endpoint.baseUrl!,
    model: endpoint.model,
    ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
  });

  // Parity with the dev harness: gate the high-impact tools and speak replies
  // when the device has a voice pipeline. `?confirm=auto|deny` is the bring-up
  // override for automated runs that can't press a native dialog.
  const confirm = confirmOverrideFromUrl() ?? createConfirmHandler();
  const agent = new Agent({ platform, llm, confirm });
  speakReplies(agent, platform);
  window.__tvAgent = agent;
  window.__tvPlatform = platform;
  console.info(
    `[aosp] agent ready on ${platform.device.model} (${platform.device.soc}) · ` +
    `llm=${llm.id} via ${endpoint.source} ${endpoint.baseUrl}`,
  );

  const ui = mountDeviceShell(agent, platform, { detail: `llm=${endpoint.baseUrl}` });
  // `?demo` runs the built-in script, `?ask=…` runs your own — either way the TV
  // does something without a keyboard.
  await runStartupCommands(ui);
}
boot();
