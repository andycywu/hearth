# ADR-0001: Web-based cross-platform runtime

- Status: Accepted
- Date: 2026-07-24

## Context
We need one agent runtime across AOSP/Android TV and Tizen, on MediaTek and
Novatek SoCs, and we intend to open-source it. Options considered: (a) native
per-platform apps, (b) a portable C++ core with per-OS adapters, (c) a
web-based runtime with a thin native bridge per OS.

## Decision
Adopt **(c) a web-based runtime**. The agent core and adapters are TypeScript
bundled to a single web app; each OS hosts it (Tizen `.wgt`; AOSP `WebView`) and
exposes native capabilities through a bridge implementing the platform HAL.

## Rationale
- Tizen's first-class app model is already a web app; AOSP can host the same
  bundle in a WebView. Maximum code reuse across all four targets.
- Both platforms ship a modern Chromium/Blink engine.
- Keeps the door open to a WebGL (Lightning 3) UI for weak GPUs.
- Lower barrier to open-source contribution (TypeScript, no toolchain per OS).

## Consequences
- Advanced hardware controls (input switch, key injection, standby) still need
  vendor SDKs or a privileged/system app — pushed into the native bridge.
- Performance on very low-end SoCs must be watched; mitigated by WebGL UI and a
  bundle-size budget.
- If a future target lacks a capable web engine, this decision would be revisited
  for that target only.
