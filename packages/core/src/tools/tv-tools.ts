import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import type { Tool } from "./registry.js";

/**
 * Factory that turns a PlatformProvider into a set of agent tools. This is the
 * single bridge between "what the LLM can ask for" and "what the platform can
 * do" — swap the provider (Tizen/AOSP/web) and the same tools keep working.
 */
export function createTvTools(platform: PlatformProvider): Tool[] {
  const tools: Tool[] = [
    {
      spec: {
        name: "set_volume",
        description: "Set the TV volume to an absolute level between 0 and 100.",
        parameters: {
          level: { type: "number", description: "Volume 0-100", required: true },
        },
      },
      execute: async (args) => {
        await platform.system.setVolume(Number((args as any).level));
        return { ok: true };
      },
    },
    {
      spec: {
        name: "set_input_source",
        description: "Switch the active input source (e.g. hdmi1, tv, app).",
        parameters: {
          source: { type: "string", description: "Input source id", required: true },
        },
      },
      execute: async (args) => {
        await platform.system.setInputSource((args as any).source);
        return { ok: true };
      },
    },
    {
      spec: {
        name: "launch_app",
        description: "Launch an installed application by its id.",
        parameters: {
          appId: { type: "string", description: "Application id", required: true },
        },
      },
      execute: async (args) => {
        await platform.apps.launchApp((args as any).appId);
        return { ok: true };
      },
    },
    {
      spec: {
        name: "list_apps",
        description: "List installed applications available to launch.",
        parameters: {},
      },
      execute: async () => platform.apps.listInstalledApps(),
    },
    {
      spec: {
        name: "press_key",
        description: "Inject a remote-control key to navigate the on-screen UI.",
        parameters: {
          key: { type: "string", description: "Remote key, e.g. up/ok/back/home", required: true },
        },
      },
      execute: async (args) => {
        await platform.navigation.sendKey((args as any).key);
        return { ok: true };
      },
    },
  ];
  return tools;
}
