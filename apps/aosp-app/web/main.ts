import { bootRuntime } from "@hearthkit/host";
import { createAospAdapter } from "@hearthkit/adapter-aosp";

/**
 * The Android TV entry. Everything that is not Android lives in
 * `@hearthkit/host` — see packages/host/src/boot.ts for why.
 */
void bootRuntime({
  name: "aosp",
  createAdapter: createAospAdapter,
  // This host really has made its window see-through: a translucent Activity
  // theme plus a cleared WebView background, so the agent sits over whatever was
  // already on screen. `?solid` turns it off for a bring-up capture.
  translucent: true,
  provisionedKeys: () => {
    // Provisioned once into the device keystore and read back through the
    // bridge, never carried in the launch URL:
    //   adb shell am start -n tv.aiagent.harness/.MainActivity -e mpKey <key>
    // Optional-chained so a newer bundle still runs on an older host APK that
    // has no such method.
    const bridge = (window as unknown as {
      TvNativeBridge?: { getLlmApiKey?: () => string; getModelPilotApiKey?: () => string };
    }).TvNativeBridge;
    return {
      llm: bridge?.getLlmApiKey?.() || undefined,
      modelPilot: bridge?.getModelPilotApiKey?.() || undefined,
    };
  },
});
