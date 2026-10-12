import { describe, expect, it } from "vitest";
import { EDGE_VOICE_DEFAULTS, resolveEdgeVoiceConfig } from "./config.js";

describe("resolveEdgeVoiceConfig", () => {
  it("is the defaults with nothing set — STT on, wake word and preprocessing off", () => {
    const { config, warnings } = resolveEdgeVoiceConfig({});
    expect(config).toEqual(EDGE_VOICE_DEFAULTS);
    expect(warnings).toEqual([]);
    expect(config.wakeWordEnabled).toBe(false);
    expect(config.audioPreprocessingEnabled).toBe(false);
  });

  it("environment beats the config file beats the default", () => {
    const { config } = resolveEdgeVoiceConfig(
      { HEARTH_STT_BACKEND: "Whisper", HEARTH_AUDIO_DEVICE: "hw:2,0" },
      { sttBackend: "vosk", audioDevice: "plughw:1", channels: 4 },
    );
    expect(config.sttBackend).toBe("whisper");
    expect(config.audioDevice).toBe("hw:2,0");
    expect(config.channels).toBe(4);
  });

  it("reads booleans in the usual spellings", () => {
    const { config } = resolveEdgeVoiceConfig({ HEARTH_WAKE_WORD_ENABLED: "ON", HEARTH_VAD_ENABLED: "0" });
    expect(config.wakeWordEnabled).toBe(true);
    expect(config.vadEnabled).toBe(false);
  });

  it("warns and falls back on a value that does not parse, instead of throwing", () => {
    const { config, warnings } = resolveEdgeVoiceConfig({
      HEARTH_SAMPLE_RATE: "sixteen", HEARTH_VAD_ENABLED: "maybe", HEARTH_LOG_LEVEL: "loud", HEARTH_CHANNELS: "99",
    });
    expect(config.sampleRate).toBe(16_000);
    expect(config.vadEnabled).toBe(true);
    expect(config.logLevel).toBe("info");
    expect(config.channels).toBe(1);
    expect(warnings).toHaveLength(4);
  });

  it("an empty variable is unset, not an empty string", () => {
    const { config } = resolveEdgeVoiceConfig({ HEARTH_AUDIO_DEVICE: "  ", HEARTH_STT_MODEL_PATH: "" });
    expect(config.audioDevice).toBe("default");
    expect(config.sttModelPath).toBeUndefined();
  });
});
