/**
 * ModelPilot, for the CLI on a Pi.
 *
 * The television's boot sequence has had ModelPilot since September; the CLI did not, so a Pi that
 * could hear a question had nothing to ask. This is the same wiring, found from the environment
 * instead of a launch URL:
 *
 *   MODELPILOT_API_KEY   the credential. Without it nothing here runs and nothing leaves the box.
 *   MODELPILOT_MODE      off | shadow (default) | enforce — see docs/modelpilot-integration.md
 *   MODELPILOT_BASE_URL  the service; production by default
 *   MODELPILOT_MAX_COST  a ceiling per task, in USD
 *   MODELPILOT_CHAT      `off` keeps conversation on whatever `--llm` says
 *   MODELPILOT_MODEL     the model asked of the router; `auto` lets it choose
 *
 * Two uses, both through the one key. **Planning**: a goal the local planner cannot close goes to
 * ModelPilot as a minimised room summary and comes back as a plan that is re-validated against this
 * device's own capabilities and read back locally — it never gets to say that something happened.
 * **Conversation**: a question that is not a device goal ("will it rain tomorrow") is a chat
 * completion with `model: "auto"`, which is what the router exists to route.
 *
 * The key is read from the environment only, like every other credential here: never a flag, never a
 * file git can see. On the Pi it belongs in `~/.config/hearth/env` (0600), which the service reads.
 */
import { loadInstallId, RUNTIME_VERSION, type LlmClient } from "@hearthkit/core";
import { createOpenAiCompatibleClient } from "@hearthkit/llm-connectors";
import {
  createModelPilotWiring, resolveModelPilotConfig, type ModelPilotConfig, type ModelPilotWiring,
} from "@hearthkit/modelpilot";
import type { KeyValueStore } from "@hearthkit/platform-api";

export interface CliModelPilot {
  config: ModelPilotConfig & { apiKey: string };
  wiring: ModelPilotWiring;
  /** Conversation through the router, unless `--llm` or `MODELPILOT_CHAT=off` said otherwise. */
  chat: { baseUrl: string; model: string; apiKey: string } | undefined;
}

export async function connectModelPilot(
  env: Record<string, string | undefined>,
  storage: KeyValueStore,
  o: { explicitLlm: boolean; log?: (record: unknown) => void },
): Promise<CliModelPilot | undefined> {
  const config = resolveModelPilotConfig({ env });
  // No credential, or switched off: no client is built, so no call can be made.
  if (!config.apiKey || config.mode === "off") return undefined;

  const installId = await loadInstallId(storage);
  const apiKey = config.apiKey;
  return {
    config: { ...config, apiKey },
    wiring: createModelPilotWiring({
      config: { ...config, apiKey }, installId, runtimeVersion: RUNTIME_VERSION,
      ...(o.log ? { telemetry: o.log } : {}),
    }),
    chat: o.explicitLlm || env.MODELPILOT_CHAT?.trim().toLowerCase() === "off"
      ? undefined
      : { baseUrl: `${config.baseUrl}/v1`, model: env.MODELPILOT_MODEL?.trim() || "auto", apiKey },
  };
}

/**
 * The chat client for conversation through the router: a plain completion, not a stream.
 *
 * The agent streams when a client offers it, and a streamed reply is the right thing on a screen. Here the
 * reply is spoken whole, so streaming buys nothing — and it is the part of "OpenAI-compatible" a router may
 * implement badly or not at all: a service that answers `stream: true` with a plain JSON body produces an
 * empty reply, silently, which is the worst way to fail. (Found by a fake that did exactly that.)
 */
export function routerChatClient(chat: NonNullable<CliModelPilot["chat"]>): LlmClient {
  const { completeStream: _stream, ...plain } = createOpenAiCompatibleClient(chat);
  return plain;
}
