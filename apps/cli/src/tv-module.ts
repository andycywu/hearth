/**
 * A television this box drives, supplied by a module that does not have to live in this repository.
 *
 * On a Pi beside the TV the platform adapter describes the *Pi*: its microphone, its speaker, its own ALSA volume. The
 * television is somewhere else on the network, and how to reach it differs per set — a debugging port on a development
 * build, a vendor bridge, a partner SDK that cannot be published. `--tv-module <path>` loads a module that knows, and
 * its controls take the places the Pi has no business filling: the volume, the input, the picture's layout, the keys.
 *
 * The module's contract is the HAL's own types, so nothing above this file learns there is a second device. A member
 * the module leaves out stays the Pi's — which for input switching is an honest `unsupported`, not a pretend success.
 *
 * A module exports `createTv(env)` (or a default function) returning a `TvModule`; it is handed the environment so it
 * can read its own settings, and is never handed the API key on a command line.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  hasCapability,
  type DisplayControl, type Navigation, type PlatformProvider, type SystemControl,
} from "@hearthkit/platform-api";

export interface TvModule {
  /** Short name for the startup log, e.g. "living-room set @ 10.0.0.2". */
  name?: string;
  system?: Partial<SystemControl>;
  navigation?: Navigation;
  display?: DisplayControl;
  /** Connect. Called once, after the box's own adapter is up. A throw stops the start: a TV that cannot be reached is not one to pretend to drive. */
  init?(): Promise<void>;
  /** Each finished turn — what was asked and what was answered — for a module that shows Hearth on the television. */
  onTurn?(input: string, output: string): void | Promise<void>;
  close?(): void | Promise<void>;
}

export type TvModuleFactory = (env: Record<string, string | undefined>) => TvModule | Promise<TvModule>;

/** Import the module at `path` (relative to the working directory) and build its TV. Substitutable `importer` for tests. */
export async function loadTvModule(
  path: string,
  env: Record<string, string | undefined>,
  importer: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
): Promise<TvModule> {
  const mod = await importer(pathToFileURL(resolve(path)).href);
  const factory = (mod.createTv ?? mod.default) as TvModuleFactory | undefined;
  if (typeof factory !== "function") throw new Error(`${path} exports neither createTv() nor a default function`);
  return await factory(env);
}

const SYSTEM_KEYS: (keyof SystemControl)[] = [
  "getVolume", "setVolume", "getMute", "setMute", "getInputSource", "setInputSource", "powerStandby",
];

/**
 * The box's platform with the television's controls laid over it.
 *
 * Per method rather than per slot: a module that can read and set the volume but not put the set in standby leaves
 * `powerStandby` to whatever the box answers, rather than the whole `system` slot being one or the other.
 */
export function withTv(base: PlatformProvider, tv: TvModule): PlatformProvider {
  const system = { ...base.system };
  for (const key of SYSTEM_KEYS) {
    const fn = tv.system?.[key];
    if (typeof fn === "function") (system as Record<string, unknown>)[key] = fn;
  }
  const display = tv.display ?? base.display;
  const provider: PlatformProvider = {
    ...base,
    system,
    navigation: tv.navigation ?? base.navigation,
    ...(display ? { display } : {}),
    has: (cap) => hasCapability(provider, cap),
    init: async () => {
      await base.init();
      await tv.init?.();
    },
  };
  return provider;
}
