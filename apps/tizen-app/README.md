# Tizen app host

Packages the agent runtime as a Tizen web app (`.wgt`).

## Build & install (Tizen Studio CLI)
```bash
# 1. Bundle the runtime into this folder (produces main.js)
pnpm bundle:tizen   # = pnpm build && node tools/bundle.mjs tizen

# 2. Package and sign
tizen build-web -- .
tizen package -t wgt -s <your-security-profile> -- .buildResult

# 3. Install on a target (MTK/NVT Tizen TV in developer mode)
sdb connect <TV_IP>
tizen install -n TvAiAgent.wgt -t <target-id>
```
See `docs/platform/tizen-bringup.md` for MTK/NVT specifics.
