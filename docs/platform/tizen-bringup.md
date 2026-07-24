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

## MTK vs NVT notes
- Privileges granted vary by firmware; trim `config.xml` to what installs.
- Advanced controls (input source, standby) commonly require partner-level
  `webapis` or a vendor privilege — request from the SoC vendor.
- Verify the Chromium engine version; keep to the ES2020 baseline.
