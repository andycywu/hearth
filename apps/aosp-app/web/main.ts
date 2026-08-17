import { Agent, runDiagnostics, reportToMarkdown, launchSearch, turnTimeoutFromUrl} from "@tv-ai-agent/core";
import { createAospAdapter } from "@tv-ai-agent/adapter-aosp";
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
  const platform = createAospAdapter();
  await platform.init();

  // The shared look, before anything is drawn. `translucent` is claimed here and
  // only here: this host really has made its window see-through (a translucent
  // Activity theme plus a cleared WebView background), so the agent sits over
  // whatever was on screen. `?solid` turns it off for a bring-up capture,
  // `?scrim=` tunes how much of the content behind stays visible.
  applyTvTheme({ translucent: true, ...tvThemeOptionsFromUrl(launchSearch()) });

  // Bring-up mode: load with `?diag` to render an on-screen capability report.
  if (/(^|[?&])diag/.test(launchSearch())) {
    const report = await runDiagnostics(platform, { allowWrites: launchSearch().includes("writes") });
    const markdown = reportToMarkdown(report) + "\nsummary: " + JSON.stringify(report.summary);
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:24px;color:#e8eefc;white-space:pre-wrap;text-align:left";
    pre.textContent = markdown;
    document.body.innerHTML = "";
    // Re-apply opaque: clearing the body took the backdrop with it, and a
    // capability report you can read the launcher through is no use to anyone.
    applyTvTheme({ translucent: false });
    document.body.appendChild(pre);
    // Also to the console so bring-up can pull it off the device without OCR:
    // `adb logcat -s chromium:I` (or the Web Inspector on Tizen/webOS).
    console.info(markdown);
    return;
  }

  // Endpoint from ?llm=/?model=, then window globals — so a shipped APK can be
  // repointed at another model without a rebuild:
  //   adb shell am start -n … -e start "index.html?llm=http://127.0.0.1:8080/v1"
  // No default endpoint: with nothing configured, fall back to the offline brain
  // that is already in this bundle rather than to a dead address. That is what
  // lets `?demo` run on a TV with no network set up yet.
  // A key provisioned into the host's encrypted store (`am start -e llmKey …`)
  // is picked up here, before the endpoint is resolved, so it never has to
  // travel in the launch URL. `?key=` still works for development and still
  // wins, because that is what you reach for when overriding on the bench.
  adoptProvisionedApiKey();
  const endpoint = resolveLlmEndpoint();
  const llm = endpoint.baseUrl
    ? createOpenAiCompatibleClient({
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
      })
    : createScriptedClient();

  // Parity with the dev harness: gate the high-impact tools and speak replies
  // when the device has a voice pipeline. `?confirm=auto|deny` is the bring-up
  // override for automated runs that can't press a native dialog.
  const confirm = confirmOverrideFromUrl() ?? createConfirmHandler();
  // `?timeout=90` when the model is slow — a local model on modest hardware
  // can take a minute a turn, and the 30s default makes that look broken.
  const turnTimeoutMs = turnTimeoutFromUrl();
  const agent = new Agent({ platform, llm, confirm, ...(turnTimeoutMs ? { turnTimeoutMs } : {}) });
  // Ask the device which tools actually work here before anything can ask
  // what we can do. On a build missing a capability inside a required
  // member — Tizen with no audio API — the alternative is promising it and
  // then declining.
  const capabilities = await agent.probeCapabilities();
  for (const note of capabilities.notes) console.info(`[capability] ${note}`);
  window.__tvAgent = agent;
  window.__tvPlatform = platform;
  console.info(
    `[aosp] agent ready on ${platform.device.model} (${platform.device.soc}) · ` +
    `llm=${llm.id} via ${endpoint.source} ${endpoint.baseUrl}`,
  );

  const ui = mountDeviceShell(agent, platform, {
    detail: `llm=${endpoint.baseUrl ?? "offline"}`,
    // The avatar is the default face; `?render=overlay` is the plain bring-up
    // view. `?keyboard` adds the remote-driven on-screen keyboard, so a TV can
    // type rather than being limited to whatever was baked into the launch
    // flags.
    ...renderOption(),
    ...keyboardOption(),
  });
  // After the shell exists, so the avatar can be told when it's speaking.
  speakReplies(agent, platform, { onSpeaking: (s) => ui.setSpeaking?.(s) });
  // `?demo` runs the built-in script, `?ask=…` runs your own — either way the TV
  // does something without a keyboard.
  await runStartupCommands(ui);
}
boot();

/**
 * Copy the host's provisioned API key into the global `resolveLlmEndpoint()`
 * reads, when there is one and the launch flags didn't supply one.
 *
 * Kept in the host entry rather than in the adapter: a credential for the model
 * is not a TV capability, and `PlatformProvider` should not grow a slot for it.
 * Guarded on the method existing so a newer bundle still runs on an older APK.
 */
function adoptProvisionedApiKey(): void {
  const bridge = (globalThis as { TvNativeBridge?: { getLlmApiKey?: () => string } }).TvNativeBridge;
  const w = window as unknown as Record<string, unknown>;
  if (w.__AGENT_LLM_API_KEY__) return;
  try {
    const key = bridge?.getLlmApiKey?.();
    if (key) w.__AGENT_LLM_API_KEY__ = key;
  } catch {
    // An older host APK without the method. Not worth a warning: no key
    // provisioned simply means the endpoint needs one from somewhere else.
  }
}
