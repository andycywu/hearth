# AOSP navigation via AccessibilityService (no special signing)

A third-party Android app cannot inject raw key events into other apps — that
needs the `INJECT_EVENTS` signature permission. To drive the 10-foot UI on a
**retail** device without platform signing, the host app ships an
`AccessibilityService` that the user enables once.

## What it can do
- Global actions: **home**, **back**, **recents** (mapped from the `menu` key).
- Directional navigation: **up / down / left / right** by moving input focus
  within the active window, and **ok** by clicking the focused element.

## What it cannot do
- `channelup` / `channeldown`, media transport keys, and raw key injection into
  arbitrary apps — those still require a system/platform signature.

The bridge reports these honestly: `sendKey` for an unreachable key throws
`Not supported`, which the agent surfaces as a failed tool call (and the `?diag`
probe marks the capability accordingly).

## Enabling it
1. Install and launch the app once.
2. Go to **Settings → Accessibility → TV AI Agent** and turn it **On**.
   (The app can deep-link here via the bridge's `openAccessibilitySettings()`.)
3. `TvNativeBridge.isAccessibilityEnabled()` returns `true` once connected; from
   then on `sendKey` routes through the service.

## How it works
- `TvAgentAccessibilityService` keeps a connected-instance reference.
- `TvNativeBridge.sendKey()` calls `TvAgentAccessibilityService.tryPressKey()`
  first; if the service is off it throws so the UI can prompt to enable it.

## First-party alternative (devices you own)
On hardware you control, platform-sign the host app (or install it as a
privileged app) to obtain `INJECT_EVENTS` for full raw key injection and drop
the AccessibilityService requirement. The web runtime is unchanged — only the
native bridge implementation differs.
