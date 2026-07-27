# webOS app host

Packages the agent runtime as a webOS web app (`.ipk`) for LG webOS TVs, using
`@tv-ai-agent/adapter-webos` (Luna Service Bus).

> Experimental — webOS is not a v1 target. This host proves the HAL extends to a
> third OS with no core changes.

## Build & install (webOS CLI / ares)

```bash
# 1. Bundle the runtime into this folder (produces main.js)
pnpm bundle:webos

# 2. Package into an .ipk (needs @webos-tools/cli: `ares-*`)
ares-package .

# 3. Install on a TV in developer mode
ares-setup-device            # one-time: register the TV
ares-install ./tv.titanos.aiagent_0.1.0_all.ipk -d <device>
ares-launch tv.titanos.aiagent -d <device>
```

Run the on-device capability probe by launching with `?diag` (e.g. set the app's
start params, or open `index.html?diag`).

Advanced controls (input source, power) are partner/platform Luna APIs; the
open-source build degrades gracefully via `has()`. See
`docs/on-device-inference.md` to point the agent at a local model.
