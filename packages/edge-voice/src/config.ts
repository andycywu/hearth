/**
 * The edge voice settings, resolved once.
 *
 * Every environment variable the voice stack reads is read here and nowhere
 * else; the rest of the code takes an `EdgeVoiceConfig`. Precedence matches the
 * CLI's — environment > config file > default — and a value that does not parse
 * is a warning and falls back, never an exception: a typo in
 * `HEARTH_SAMPLE_RATE` should not stop a television from listening.
 */
export interface EdgeVoiceConfig {
  audioDevice: string;
  sampleRate: number;
  channels: number;
  audioPreprocessingEnabled: boolean;
  wakeWordEnabled: boolean;
  wakeWord: string;
  vadEnabled: boolean;
  /** `sherpa` today; the backend registry decides what else is valid. */
  sttBackend: string;
  /** Directory (or file) the backend loads its model from. */
  sttModelPath: string | undefined;
  sttLanguage: string | undefined;
  /** Where an already-running STT server listens, if one is. Overrides launching one. */
  sttServerUrl: string | undefined;
  /** The unpacked STT runtime (for sherpa-onnx: the release directory holding bin/ and lib/). */
  sttRuntimePath: string | undefined;
  logLevel: "debug" | "info" | "warn" | "error";
}

export const EDGE_VOICE_DEFAULTS: EdgeVoiceConfig = {
  audioDevice: "default",
  sampleRate: 16_000,
  channels: 1,
  audioPreprocessingEnabled: false,
  wakeWordEnabled: false,
  wakeWord: "hearth",
  vadEnabled: true,
  sttBackend: "sherpa",
  sttModelPath: undefined,
  sttLanguage: undefined,
  sttServerUrl: undefined,
  sttRuntimePath: undefined,
  logLevel: "info",
};

const LEVELS = ["debug", "info", "warn", "error"] as const;

export function resolveEdgeVoiceConfig(
  env: Record<string, string | undefined>,
  file: Partial<EdgeVoiceConfig> = {},
): { config: EdgeVoiceConfig; warnings: string[] } {
  const warnings: string[] = [];
  const base: EdgeVoiceConfig = { ...EDGE_VOICE_DEFAULTS, ...stripUndefined(file) };

  const str = (name: string, fallback: string): string => env[name]?.trim() || fallback;
  const optStr = (name: string, fallback: string | undefined): string | undefined => env[name]?.trim() || fallback;
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    warnings.push(`${name}=${JSON.stringify(env[name])} is not a boolean; using ${fallback}`);
    return fallback;
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    warnings.push(`${name}=${JSON.stringify(raw)} is not an integer in ${min}..${max}; using ${fallback}`);
    return fallback;
  };

  const level = str("HEARTH_LOG_LEVEL", base.logLevel).toLowerCase();
  const logLevel = (LEVELS as readonly string[]).includes(level) ? (level as EdgeVoiceConfig["logLevel"]) : base.logLevel;
  if (logLevel !== level) warnings.push(`HEARTH_LOG_LEVEL=${JSON.stringify(level)} is not one of ${LEVELS.join("/")}; using ${base.logLevel}`);

  return {
    warnings,
    config: {
      audioDevice: str("HEARTH_AUDIO_DEVICE", base.audioDevice),
      sampleRate: int("HEARTH_SAMPLE_RATE", base.sampleRate, 8_000, 48_000),
      channels: int("HEARTH_CHANNELS", base.channels, 1, 8),
      audioPreprocessingEnabled: bool("HEARTH_AUDIO_PREPROCESSING_ENABLED", base.audioPreprocessingEnabled),
      wakeWordEnabled: bool("HEARTH_WAKE_WORD_ENABLED", base.wakeWordEnabled),
      wakeWord: str("HEARTH_WAKE_WORD", base.wakeWord),
      vadEnabled: bool("HEARTH_VAD_ENABLED", base.vadEnabled),
      sttBackend: str("HEARTH_STT_BACKEND", base.sttBackend).toLowerCase(),
      sttModelPath: optStr("HEARTH_STT_MODEL_PATH", base.sttModelPath),
      sttLanguage: optStr("HEARTH_STT_LANGUAGE", base.sttLanguage),
      sttServerUrl: optStr("HEARTH_STT_SERVER_URL", base.sttServerUrl),
      sttRuntimePath: optStr("HEARTH_STT_RUNTIME_PATH", base.sttRuntimePath),
      logLevel,
    },
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
