# Tizen bring-up (MTK / NVT)

## Prerequisites
- Tizen Studio + TV extension, a valid **author + distributor security profile**.
- TV in Developer Mode; note its IP.

## Steps
1. Bundle: `node tools/bundle.mjs tizen` (produces `apps/tizen-app/main.js`).
2. Package & sign:
   ```bash
   cd apps/tizen-app
   tizen build-web -- .
   tizen package -t wgt -s <profile> -- .buildResult
   ```
3. Install: `sdb connect <TV_IP> && tizen install -n TvAiAgent.wgt -t <target>`.
4. Launch, open the on-screen status, confirm `device.model` / `device.soc`.
5. Walk the HAL: volume, list/launch app, network. Record results in
   `capability-matrix.md`.

## Privilege levels (the real gate)
Tizen privileges are tiered **public / partner / platform** and the gate is the
signing **certificate**, not a proprietary SDK:
- **public** (any Tizen-Studio author cert): volume, `application.*` launch/info,
  internet. Covers the core agent.
- **partner / platform**: input-source (`tvinfo`/`tv-control`), power. Need a
  **partner or platform certificate** issued by Samsung to partners — you cannot
  self-sign these. On TitanOS-owned devices, sign at partner/platform level to
  unlock them.

## MTK vs NVT notes
- Granted privileges vary by firmware; trim `config.xml` to what installs.
- MTK vs NVT differ mainly in Chromium engine version and GPU performance, not in
  which APIs exist — verify the engine version and keep to the ES2020 baseline.
