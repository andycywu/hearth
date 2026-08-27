import {
  Agent, runDiagnostics, reportToMarkdown, launchSearch, turnTimeoutFromUrl,
  discoverRoom, deviceTreeText, describeFeatures, loadInstallId, RUNTIME_VERSION,
  type PlannerContext,
} from "@hearthkit/core";
import { createOpenAiCompatibleClient, createScriptedClient, resolveLlmEndpoint } from "@hearthkit/llm-connectors";
import {
  createConfirmHandler, confirmOverrideFromUrl, runStartupCommands, mountDeviceShell, speakReplies,
  exposeDeviceReport, keyboardOption, renderOption, applyTvTheme, tvThemeOptionsFromUrl,
} from "@hearthkit/ui";
import {
  createModelPilotClient, createModelPilotPlanner, resolveModelPilotConfig,
} from "@hearthkit/modelpilot";
import type { PlatformProvider } from "@hearthkit/platform-api";

/**
 * The boot sequence, once.
 *
 * There were three of these — Android 200 lines, Tizen 174, webOS 159 — and once
 * the platform names were normalised, Tizen and webOS differed by 73 lines,
 * mostly comments. That is not three implementations; it is one implementation
 * pasted twice, and it behaved like it. Wiring ModelPilot in meant writing the
 * same forty lines three times, and the `?diag&reach` probe and the plan-event
 * logging each survived on exactly one host, because nobody remembered to copy
 * them to the others.
 *
 * So the sequence lives here, and a host supplies only what genuinely differs:
 * which adapter, whether its window can really be see-through, what to check
 * before starting, and where a credential the platform provisioned is read from.
 */
export interface HostDefinition {
  /** Short name for logs — `aosp`, `tizen`, `webos`. */
  name: string;
  createAdapter: () => PlatformProvider;
  /**
   * Whether this host's window really is see-through. Android's Activity is;
   * Tizen's web runtime gives a web app no way to be, and a translucent page
   * there composites the scrim over the runtime's own pale backing and washes
   * the whole screen out. Default false — claiming it falsely looks broken.
   */
  translucent?: boolean;
  /**
   * Checked before the adapter is created. Throw with a sentence someone can
   * act on: webOS uses this to say webOSTV.js is missing, rather than failing
   * later with "webOS is not defined".
   */
  preflight?: () => void;
  /**
   * Credentials the platform provisioned outside the launch URL — Android's
   * encrypted keystore, read through the native bridge. A launch URL lives in
   * shell history, in the launch intent and in logcat, and on a shipped
   * television that key is identical on every unit, so this is the only
   * sanctioned path.
   */
  provisionedKeys?: () => { llm?: string | undefined; modelPilot?: string | undefined };
  /** Where a full-screen report is written. Default: `#app`, else `document.body`. */
  reportRootId?: string;
  /** Element that shows a boot failure, when the page has one. Default `#status`. */
  statusId?: string;
}

export interface BootedRuntime {
  agent: Agent;
  platform: PlatformProvider;
}

/**
 * Boots a television. Resolves once the shell is up and any startup command has
 * been dispatched, and resolves to `undefined` if the launch was a diagnostics
 * run or if boot failed and the failure was put on screen.
 */
export async function bootRuntime(host: HostDefinition): Promise<BootedRuntime | undefined> {
  try {
    host.preflight?.();
    const platform = host.createAdapter();
    await platform.init();

    // The shared look, before anything is drawn. `?scrim=` tunes how much of
    // whatever is behind stays visible; `?translucent` / `?solid` override.
    applyTvTheme({
      translucent: host.translucent ?? false,
      ...tvThemeOptionsFromUrl(launchSearch()),
    });

    // A credential the host provisioned goes into the globals the resolvers
    // read, before either of them runs — and never into the URL.
    const provisioned = readProvisionedKeys(host);
    const endpoint = resolveLlmEndpoint();

    // Bring-up: `?diag` renders a capability report instead of the agent.
    // Guarded, because the probes and their markdown are 7.9 KB that a working
    // television never executes. The guard has to be written inline like this —
    // see packages/core/src/features.ts for why.
    if (typeof __HEARTH_DIAG__ === "undefined" || __HEARTH_DIAG__) {
      if (/(^|[?&])diag/.test(launchSearch())) {
        await showDiagnostics(platform, endpoint.baseUrl, host);
        return undefined;
      }
    }

    const llm = endpoint.baseUrl
      ? createOpenAiCompatibleClient({
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
        })
      // The offline scripted brain, in builds that carry it. It is a keyword
      // matcher rather than a model, which is what lets `?demo` run on a set
      // whose network was never configured — and also 11 KB on every television
      // that will never use it. A build without it says so instead of pretending.
      : (typeof __HEARTH_OFFLINE__ === "undefined" || __HEARTH_OFFLINE__)
        ? createScriptedClient()
        : noModelConfigured();

    // Gate the high-impact tools. `?confirm=auto|deny` is the bring-up override
    // for automated runs that cannot press a native dialog.
    const confirm = confirmOverrideFromUrl() ?? createConfirmHandler();
    // `?timeout=90` when the model is slow: a local model on modest hardware can
    // take a minute a turn, and the 30s default makes that look broken.
    const turnTimeoutMs = turnTimeoutFromUrl();
    // What is in the room: what storage remembers, plus what the TV can see.
    // `?room=demo` seeds a console on HDMI2 so the multi-device scenario has
    // something to plan for on a set with nothing plugged in.
    const devices = await discoverRoom(platform);

    // A random, resettable, device-generated id — never a hardware identifier —
    // carried only on ModelPilot calls, so the service can count installations
    // without the runtime phoning home. See docs/service-metrics.md.
    const installId = await loadInstallId(platform.storage);
    const modelPilot = buildModelPilotPlanner(provisioned.modelPilot, installId);

    const agent = new Agent({
      platform, llm, confirm, devices,
      ...(modelPilot ? { planner: modelPilot, llmPlanning: true } : {}),
      ...(turnTimeoutMs ? { turnTimeoutMs } : {}),
    });

    // Ask the device which tools actually work here before anything can ask what
    // we can do. On a build missing a capability inside a required member — a
    // Tizen image with no audio API — the alternative is promising it and then
    // declining.
    const capabilities = await agent.probeCapabilities();
    for (const note of capabilities.notes) console.info(`[capability] ${note}`);
    // Logged rather than only rendered: on a television you cannot attach a
    // debugger to, this is how anyone finds out the agent thinks the games
    // console is on HDMI3.
    for (const line of deviceTreeText(devices).split("\n")) console.info(`[devices] ${line}`);

    const w = window as unknown as { __tvAgent?: Agent; __tvPlatform?: PlatformProvider };
    w.__tvAgent = agent;
    w.__tvPlatform = platform;
    if (typeof __HEARTH_DIAG__ === "undefined" || __HEARTH_DIAG__) {
      // One call, one pasteable Hearth Report — see tools/device-report.mjs.
      exposeDeviceReport(agent, platform);
    }

    console.info(
      `[${host.name}] agent ready on ${platform.device.model} (${platform.device.soc}) · ` +
      `llm=${llm.id} via ${endpoint.source} ${endpoint.baseUrl ?? "(none)"} · ` +
      `build=${describeFeatures()}`,
    );

    // Say which brain is answering: "it works but the model isn't real" is a
    // distinction someone watching a television has no other way to make.
    const ui = mountDeviceShell(agent, platform, {
      detail: `llm=${endpoint.baseUrl ?? llm.id}`,
      ...renderOption(),
      ...keyboardOption(),
    });

    logPlanLifecycle(agent);

    // After the shell exists, so the avatar can be told when it is speaking.
    speakReplies(agent, platform, { onSpeaking: (s) => ui.setSpeaking?.(s) });
    // `?demo` runs the built-in script, `?ask=…` runs your own — either way the
    // television does something without a keyboard.
    await runStartupCommands(ui);

    return { agent, platform };
  } catch (e) {
    const message = `Boot error: ${(e as Error).message}`;
    console.error(`[${host.name}] ${message}`);
    const status = document.getElementById(host.statusId ?? "status");
    if (status) status.textContent = message;
    return undefined;
  }
}

/**
 * Copy host-provisioned credentials into the globals the resolvers read.
 *
 * Kept out of `PlatformProvider`: a credential for a model is not a television
 * capability, and the HAL should not grow a slot for one. Guarded because a
 * newer bundle has to keep running on an older host binary that has no such
 * method — no key provisioned simply means it has to come from somewhere else.
 */
function readProvisionedKeys(host: HostDefinition): { llm?: string; modelPilot?: string } {
  let keys: { llm?: string | undefined; modelPilot?: string | undefined } = {};
  try {
    keys = host.provisionedKeys?.() ?? {};
  } catch {
    return {};
  }
  const w = window as unknown as Record<string, unknown>;
  // `?key=` still wins: it is what you reach for when overriding on the bench.
  if (keys.llm && !w.__AGENT_LLM_API_KEY__) w.__AGENT_LLM_API_KEY__ = keys.llm;
  return {
    ...(keys.llm ? { llm: keys.llm } : {}),
    ...(keys.modelPilot ? { modelPilot: keys.modelPilot } : {}),
  };
}

/**
 * ModelPilot, when a credential has been configured — and nothing otherwise, so
 * a television with no key never reaches for a cloud endpoint.
 * `?modelpilot=shadow|enforce` picks the mode for one launch without a rebuild;
 * the key is never read from the URL.
 *
 * A factory rather than an instance, so the planner reasons over the agent's own
 * capability graph — the one the boot probe withdraws from, not a copy that
 * would keep proposing capabilities this build has already given up on.
 */
function buildModelPilotPlanner(
  provisionedKey: string | undefined,
  installId: string,
): ((ctx: PlannerContext) => ReturnType<typeof createModelPilotPlanner>) | undefined {
  if (typeof __HEARTH_MODELPILOT__ !== "undefined" && !__HEARTH_MODELPILOT__) return undefined;

  const config = resolveModelPilotConfig({
    search: launchSearch(),
    globals: {
      ...(window as unknown as Record<string, unknown>),
      ...(provisionedKey ? { __MODELPILOT_API_KEY__: provisionedKey } : {}),
    },
  });
  console.info(`[modelpilot] mode=${config.mode} (${config.source})`);
  if (!config.apiKey) return undefined;

  const key = config.apiKey;
  return (ctx: PlannerContext) => createModelPilotPlanner({
    client: createModelPilotClient({
      baseUrl: config.baseUrl,
      apiKey: key,
      timeoutMs: config.timeoutMs,
      identity: { installId, runtimeVersion: RUNTIME_VERSION, mode: config.mode },
    }),
    mode: config.mode,
    graph: ctx.capabilities,
    world: ctx.world,
    devices: ctx.devices,
    meter: ctx.meter,
    maxTaskBudget: config.maxTaskBudget,
    telemetry: (record: unknown) => console.info("[modelpilot]", JSON.stringify(record)),
  });
}

/**
 * Plan lifecycle into the platform log.
 *
 * The same reason the device tree is there: on a television you cannot attach a
 * debugger to, this is the only way to see that a step ran, what it verified,
 * and whether the answer was `unsupported` rather than a failure. It is also
 * what an automated bring-up run reads. It existed on Android alone, which is
 * exactly what three copies of a boot sequence produce.
 */
function logPlanLifecycle(agent: Agent): void {
  agent.events.on("plan:start", ({ plan }) =>
    console.info(`[plan] ${plan.goal.id}: ${plan.steps.map((s) => s.action.capabilityId).join(" -> ") || "(nothing runnable)"}`));
  agent.events.on("plan:step", ({ outcome }) =>
    console.info(`[plan] ${outcome.step.action.capabilityId} ${JSON.stringify(outcome.step.action.args)} — ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ""}`));
  agent.events.on("plan:end", ({ outcome }) =>
    console.info(`[plan] done: achieved=${outcome.achieved} — ${agent.describe(outcome)}`));
}

/**
 * `?diag`, and `?diag&reach` to prove the set has a route: its own model
 * endpoint, plus a public one, so "cannot reach the host" can be told apart from
 * "no network at all". Opt-in, so a plain `?diag` stays offline.
 */
async function showDiagnostics(
  platform: PlatformProvider,
  baseUrl: string | undefined,
  host: HostDefinition,
): Promise<void> {
  const search = launchSearch();
  const report = await runDiagnostics(platform, {
    allowWrites: search.includes("writes"),
    ...(search.includes("reach")
      ? {
          reachUrls: [
            ...(baseUrl ? [`${baseUrl}/models`] : []),
            "https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m",
          ],
        }
      : {}),
  });
  const markdown = `${reportToMarkdown(report)}\nsummary: ${JSON.stringify(report.summary)}`;
  // To the console as well, so bring-up can pull it off the device as text
  // rather than by photographing the screen.
  console.info(markdown);

  const root = document.getElementById(host.reportRootId ?? "app") ?? document.body;
  const pre = document.createElement("pre");
  pre.style.cssText = "padding:24px;font-size:20px;color:#e8eefc;white-space:pre-wrap;text-align:left";
  pre.textContent = markdown;
  // Opaque: a capability report you can read the launcher through is no use to
  // anyone, and clearing the root took the backdrop with it.
  applyTvTheme({ translucent: false });
  root.innerHTML = "";
  root.appendChild(pre);
}

/**
 * What a build with no offline brain and no endpoint has to say.
 *
 * Not a silent stub: a television that answers nothing looks identical to one
 * that is broken, and the difference — nobody configured a model — is the one
 * thing whoever installed it needs to know.
 */
function noModelConfigured(): never {
  throw new Error(
    "No model endpoint configured. Launch with ?llm=<base-url> (and ?model=), or " +
    "build with --with offline to include the offline scripted brain.",
  );
}
