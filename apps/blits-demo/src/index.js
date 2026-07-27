import Blits from "@lightningjs/blits";
import { Agent } from "@tv-ai-agent/core";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import { createScriptedClient } from "@tv-ai-agent/llm-connectors";

/**
 * Lightning 3 / Blits (WebGL) UI for the agent. Everything renders on the GPU
 * canvas — the production path for low-end MTK/NVT GPUs. Crucially, the wiring
 * below (subscribe to agent events → update reactive state) is IDENTICAL to the
 * DOM overlay and the 2D-canvas renderer: only the view layer changed.
 *
 * A short scripted sequence runs on boot so the demo visibly streams into the
 * WebGL scene; press Enter to replay. Real input would come from voice/remote.
 */
const DEMO = ["set volume to 30", "make it louder", "open Netflix", "現在音量多少?"];

const App = Blits.Application({
  template: `
    <Element w="1920" h="1080" color="#05060a">
      <Text content="TV AI Agent · Blits (WebGL)" x="80" y="80" size="40" color="#8aa0d0" />
      <Text content="$reply" x="80" y="840" size="56" color="#e8eefc" />
      <Text content="$activity" x="80" y="940" size="30" color="#7f8aa3" />
      <Text content="$hint" x="80" y="1000" size="24" color="#4a5570" />
    </Element>
  `,
  state() {
    return { reply: "Ready", activity: "", hint: "Press OK/Enter to run the demo" };
  },
  hooks: {
    ready() {
      const platform = createWebAdapter();
      const agent = new Agent({ platform, llm: createScriptedClient(), confirm: () => true });
      agent.events.on("turn:start", () => { this.reply = ""; this.activity = ""; });
      agent.events.on("token", ({ delta }) => { this.reply += delta; });
      agent.events.on("tool:call", ({ name, args }) => { this.activity = `· ${name}(${JSON.stringify(args)})`; });
      agent.events.on("turn:end", ({ output }) => { if (!this.reply) this.reply = output; this.activity = ""; });
      this._agent = agent;
      this._i = 0;
      this.next();
    },
  },
  methods: {
    async next() {
      const cmd = DEMO[this._i % DEMO.length];
      this._i++;
      this.hint = `▶ ${cmd}`;
      await this._agent.run(cmd);
    },
  },
  input: {
    enter() { this.next(); },
    right() { this.next(); },
  },
});

Blits.Launch(App, "app", { w: 1920, h: 1080, canvasColor: "#05060a" });
