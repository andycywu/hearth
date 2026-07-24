import { describe, it } from "vitest";
import { assertProviderContract } from "@tv-ai-agent/platform-api";
import { createWebAdapter } from "./index.js";

describe("adapter-web", () => {
  it("satisfies the provider contract", async () => {
    await assertProviderContract(() => createWebAdapter());
  });
});
