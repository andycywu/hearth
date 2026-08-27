import {
  Agent, runDiagnostics, reportToMarkdown, launchSearch, turnTimeoutFromUrl,
  discoverRoom, deviceTreeText, loadInstallId, RUNTIME_VERSION,
  type PlannerContext,
} from "@hearthkit/core";
import { createTizenAdapter } from "@hearthkit/adapter-tizen";
import { createOpenAiCompatibleClient, createScriptedClient, resolveLlmEndpoint } from "@hearthkit/llm-connectors";
import {
  createConfirmHandler, confirmOverrideFromUrl, runStartupCommands, mountDeviceShell, speakReplies,
  exposeDeviceReport,
  keyboardOption, renderOption, applyTvTheme, tvThemeOptionsFromUrl,
} from "@hearthkit/ui";
import {
  createModelPilotClient, createModelPilotPlanner, resolveModelPilotConfig,
} from "@hearthkit/modelpilot";
import type { PlatformProvider } from "@hearthkit/platform-api";

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

    // The shared look, before anything is drawn. Opaque: this runtime gives a
    // web app no way to make its window see-through, so a translucent page just
    // composites the scrim over the runtime's own pale backing and the whole
    // screen comes out washed-out grey. `?translucent` to try it anyway on a
    // build that does composite, `?scrim=` to tune it.
    applyTvTheme({ translucent: false, ...tvThemeOptionsFromUrl(launchSearch()) });

    // ?llm=/?model= → window globals → nothing, so a packaged .wgt can be
    // repointed at another endpoint without a rebuild. Deliberately no default
    // endpoint: with nothing configured we fall back to the offline brain below
    // rather than to a dead address.
    const endpoint = resolveLlmEndpoint();

    // Bring-up mode: open the app with `?diag` to render a capability report.
    if (/(^|[?&])diag/.test(launchSearch())) {
      const report = await runDiagnostics(platform, {
        allowWrites: launchSearch().includes("writes"),
        // `?diag&reach` also proves the device has a route: its own model
        // endpoint, and a public one to tell "can't reach the host" apart from
        // "no network at all". Opt-in, so a plain ?diag stays offline.
        ...(launchSearch().includes("reach")
          ? {
              reachUrls: [
                ...(endpoint.baseUrl ? [`${endpoint.baseUrl}/models`] : []),
                "https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m",
              ],
            }
          : {}),
      });
      renderDiagnostics(report);
      return;
    }
    // The offline brain is already in this bundle, so a freshly installed TV can
    // run the whole agent loop with no network, no endpoint and no API key —
    // which is the point of `?demo`. Requiring HTTP for it meant the demo could
    // not run on a TV whose network wasn't set up yet, or on an emulator image
    // whose NAT is broken.
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
    // `?timeout=90` when the model is slow — a local model on modest hardware
    // can take a minute a turn, and the 30s default makes that look broken.
    const turnTimeoutMs = turnTimeoutFromUrl();
    // What is in the room: what was registered into storage, plus what the TV
    // itself can see. `?room=demo` seeds a console on HDMI2 so the multi-device
    // scenario has something to plan for on a set with nothing plugged in.
    const devices = await discoverRoom(platform);
    for (const line of deviceTreeText(devices).split("\n")) console.info(`[devices] ${line}`);

    // ModelPilot, when a credential has been configured — and off otherwise, so
    // a television with no key never reaches for a cloud endpoint.
    // `?modelpilot=shadow|enforce` picks the mode for one launch without a
    // rebuild; the key is never read from the URL.
    //
    // A factory, so the planner reasons over the agent's own capability graph:
    // the one the boot probe withdraws from, not a copy that would keep
    // proposing capabilities this build has already given up on.
    const mpConfig = resolveModelPilotConfig({
      search: launchSearch(),
      globals: window as unknown as Record<string, unknown>,
    });
    const installId = await loadInstallId(platform.storage);
    const modelPilot = mpConfig.apiKey
      ? (ctx: PlannerContext) => createModelPilotPlanner({
        client: createModelPilotClient({
          baseUrl: mpConfig.baseUrl,
          apiKey: mpConfig.apiKey!,
          timeoutMs: mpConfig.timeoutMs,
          identity: { installId, runtimeVersion: RUNTIME_VERSION, mode: mpConfig.mode },
        }),
        mode: mpConfig.mode,
        graph: ctx.capabilities,
        world: ctx.world,
        devices: ctx.devices,
        meter: ctx.meter,
        maxTaskBudget: mpConfig.maxTaskBudget,
        telemetry: (record: unknown) => console.info("[modelpilot]", JSON.stringify(record)),
      })
      : undefined;
    console.info(`[modelpilot] mode=${mpConfig.mode} (${mpConfig.source})`);

    const agent = new Agent({
      platform, llm, confirm, devices,
      ...(modelPilot ? { planner: modelPilot, llmPlanning: true } : {}),
      ...(turnTimeoutMs ? { turnTimeoutMs } : {}),
    });
    // Ask the device which tools actually work here before anything can ask
    // what we can do. On a build missing a capability inside a required
    // member — Tizen with no audio API — the alternative is promising it and
    // then declining.
    const capabilities = await agent.probeCapabilities();
    for (const note of capabilities.notes) console.info(`[capability] ${note}`);
    window.__tvAgent = agent;
    window.__tvPlatform = platform;
    // One call, one pasteable Hearth Report — see tools/device-report.mjs.
    exposeDeviceReport(agent, platform);

    // Say which brain is answering: "it works but the model isn't real" is a
    // distinction someone watching a TV has no other way to make.
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

function renderDiagnostics(report: Awaited<ReturnType<typeof runDiagnostics>>): void {
  const markdown = reportToMarkdown(report) + "\nsummary: " + JSON.stringify(report.summary);
  // Console too, so the Web Inspector gives you copyable text (no OCR).
  console.info(markdown);
  const app = document.getElementById("app");
  if (!app) return;
  const pre = document.createElement("pre");
  pre.style.cssText = "padding:24px;font-size:20px;white-space:pre-wrap;text-align:left";
  pre.textContent = markdown;
  // Opaque for the report: it is read, not glanced at.
  applyTvTheme({ translucent: false });
  app.innerHTML = "";
  app.appendChild(pre);
}

boot();
