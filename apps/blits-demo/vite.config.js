import { defineConfig } from "vite";
import blitsVitePlugins from "@lightningjs/blits/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Resolve the agent packages to their built dist (run `pnpm build` at the repo
// root first). Keeps this demo out of the pnpm workspace so Vite/Blits don't
// bloat the main install or CI.
const pkg = (name) => resolve(here, `../../packages/${name}/dist/index.js`);

export default defineConfig({
  plugins: [...blitsVitePlugins],
  resolve: {
    alias: {
      "@hearthkit/core": pkg("core"),
      "@hearthkit/platform-api": pkg("platform-api"),
      "@hearthkit/adapter-web": pkg("adapter-web"),
      "@hearthkit/llm-connectors": pkg("llm-connectors"),
      "@hearthkit/ui": pkg("ui"),
    },
  },
});
