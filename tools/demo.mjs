#!/usr/bin/env node
/**
 * Local demo: runs the agent with the web/mock adapter and a fake scripted LLM,
 * so you can see the loop work with `node tools/demo.mjs` after `pnpm build`.
 */
import { Agent } from "../packages/core/dist/index.js";
import { createWebAdapter } from "../packages/adapter-web/dist/index.js";

const platform = createWebAdapter();
await platform.init();

let step = 0;
const scriptedLlm = {
  id: "scripted",
  async complete() {
    step++;
    if (step === 1) {
      return {
        wantsToolCalls: true,
        message: { role: "assistant", content: "",
          toolCalls: [{ id: "1", name: "set_volume", args: { level: 30 } }] },
      };
    }
    return { wantsToolCalls: false,
      message: { role: "assistant", content: "Volume is now 30." } };
  },
};

const agent = new Agent({ platform, llm: scriptedLlm });
agent.events.on("tool:call", (e) => console.log("→ tool", e.name, e.args));
console.log("Assistant:", await agent.run("set the volume to 30 percent"));
