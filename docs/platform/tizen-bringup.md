# Tizen bring-up (MTK / NVT)

## Prerequisites
- The **Tizen VS Code extension** and its `tz` CLI (Tizen Studio is EOL), plus a
  signing profile — `tz cert` + `tz security-profiles add` create one locally with
  no Samsung account for public-level capabilities. Flags:
  [`EMULATOR_SETUP.md`](../EMULATOR_SETUP.md) §A2.
- TV in Developer Mode; note its IP.

## Steps
1. Build & sign in one step: `pnpm package:tizen` → `apps/tizen-app/Debug/tizen-app.wgt`.
2. Install: `sdb connect <TV_IP> && tz install -n apps/tizen-app/Debug/tizen-app.wgt`.
3. Launch (`tz run -n tvaiagent.TvAiAgent`), open the on-screen status, confirm
   `device.model` / `device.soc`.
4. Walk the HAL: volume, list/launch app, network. Record results in
   `capability-matrix.md`. Use `?diag` for the capability probe — the report goes
   to the console too, so the Web Inspector gives you copyable text.

## Privilege levels (the real gate)
Tizen privileges are tiered **public / partner / platform** and the gate is the
signing **certificate**, not a proprietary SDK:
- **public** (any locally generated author cert — `tz cert`): volume,
  `application.*` launch/info, internet. Covers the core agent.
- **partner / platform**: input-source (`tvinfo`/`tv-control`), power. Need a
  **partner or platform certificate** issued by Samsung to partners — you cannot
  self-sign these. On devices you own, sign at partner/platform level to
  unlock them.

## MTK vs NVT notes
- Granted privileges vary by firmware; trim `config.xml` to what installs.
- MTK vs NVT differ mainly in Chromium engine version and GPU performance, not in
  which APIs exist — verify the engine version and keep to the ES2020 baseline.
