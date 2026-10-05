/**
 * `~/.config/hearth/config.json` — what `hearth setup` found, so the next
 * `hearth` needs no flags.
 *
 * The file sits beside `store.json` (the adapter's key-value store) and is
 * deliberately not the same file: the store is the agent's memory and is
 * written by tools; this is the operator's choices and is written by setup.
 * A skill installing itself must never be able to change which platform the
 * CLI drives.
 *
 * Precedence is flag > environment > this file > default — the file is the
 * quietest voice, so anything someone types still wins.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HearthConfig {
  platform?: "mock" | "linux";
  /** CEC adapter path, or `false` to leave the bus alone. */
  cec?: string | false;
  /** Listen on the microphone by default. */
  voice?: boolean;
  asrBaseUrl?: string;
  asrModel?: string;
  /** Show outcomes on the APA102 ring by default. */
  leds?: boolean;
  /** Attention word; see `CliOptions.wakeWord`. */
  wakeWord?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  /** When and by what this was written — for the person reading the file, not the code. */
  writtenBy?: string;
  writtenAt?: string;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "hearth", "config.json");
}

/** Missing or unreadable is the normal first run: an empty config, not an error. */
export async function loadConfig(path = configPath()): Promise<HearthConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as HearthConfig) : {};
  } catch {
    return {};
  }
}

export async function saveConfig(config: HearthConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * The config, expressed as the environment variables it stands in for, so the
 * argument parser has one rule — flag > env > default — and the file slots in
 * underneath the real environment rather than adding a fourth path through
 * the parser.
 */
export function configAsEnv(config: HearthConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.platform) env.TV_PLATFORM = config.platform;
  if (config.llmBaseUrl) env.TV_AGENT_LLM = config.llmBaseUrl;
  if (config.llmModel) env.TV_AGENT_MODEL = config.llmModel;
  if (config.asrBaseUrl) env.TV_AGENT_ASR = config.asrBaseUrl;
  if (config.asrModel) env.TV_AGENT_ASR_MODEL = config.asrModel;
  if (config.cec !== undefined) env.HEARTH_CEC = config.cec === false ? "off" : config.cec;
  if (config.voice) env.HEARTH_VOICE = "1";
  if (config.leds) env.HEARTH_LEDS = "1";
  if (config.wakeWord) env.HEARTH_WAKE = config.wakeWord;
  return env;
}
