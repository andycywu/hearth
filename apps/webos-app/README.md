# webOS app host

Packages the agent runtime as a webOS web app (`.ipk`) for LG webOS TVs, using
`@tv-ai-agent/adapter-webos` (Luna Service Bus).

> Experimental — webOS is not a v1 target. This host proves the HAL extends to a
> third OS with no core changes.

## Build & install (webOS CLI / ares)

```bash
# One-time: the webOS TV CLI. No account or certificate is needed to *build*.
npm i -g @webos-tools/cli          # or: npm i @webos-tools/cli, then --ares-bin

# Bundle + package (generates icon.png if missing):
pnpm package:webos                 # → dist-ipk/tv.aiagent.harness_0.1.0_all.ipk
pnpm package:webos --ares-bin ./node_modules/.bin      # local CLI install

# Install on a TV in developer mode
ares-setup-device                  # one-time: register the TV
ares-install dist-ipk/tv.aiagent.harness_0.1.0_all.ipk -d <device>
ares-launch tv.aiagent.harness -d <device>
ares-inspect tv.aiagent.harness -d <device>            # devtools
```

Verified: a 34 KB `.ipk` containing `appinfo.json`, `icon.png`, `index.html`,
`main.js` and `packageinfo.json`.

Run the on-device capability probe by launching with `?diag`; the report is also
written to the console, so `ares-inspect` gives you copyable text. `?llm=…&model=…`
repoints a packaged app at another endpoint without rebuilding, and
`?confirm=auto|deny` is the override for automated runs.

## Two things `ares-package` does that you have to work around
Both are handled by `tools/package-webos.mjs`:
- It **minifies** every `.js` with an old uglify-js that can't parse ES2020, so it
  fails with "Failed to minify code" on our bundle. `-n` / `--no-minify` fixes it
  (the flag exists but isn't in `--help`); esbuild has already minified anyway.
- It packages the **whole app directory**, which in a pnpm workspace means the
  entire linked `node_modules` tree plus the TypeScript source and sourcemap —
  290 KB instead of 34 KB. The script passes `-e` excludes.

Advanced controls (input source, power) are partner/platform Luna APIs; the
open-source build degrades gracefully via `has()`. See
`docs/on-device-inference.md` to point the agent at a local model.
