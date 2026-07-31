# Capability matrix (fill during Phase 2 bring-up)

Legend: ✅ works · ⚠️ needs partner/platform/system signing · ❔ untested · ➖ n/a

**POC-safe rows (no signing needed):** volume, mute, list/launch apps, network,
navigation, media. The ⚠️ rows (input source, key injection, power standby) are
deferred until a self-signed eng board — see [`../POC.md`](../POC.md).

| Capability        | AOSP emu | AOSP+MTK | AOSP+NVT | Tizen+MTK | Tizen+NVT |
|-------------------|----------|----------|----------|-----------|-----------|
| set/get volume    | ✅       | ❔       | ❔       | ❔        | ❔        |
| mute              | ✅       | ❔       | ❔       | ❔        | ❔        |
| list apps         | ✅       | ❔       | ❔       | ❔        | ❔        |
| launch app        | ✅       | ❔       | ❔       | ❔        | ❔        |
| input source      | ⏭️       | ⚠️       | ⚠️       | ⚠️        | ⚠️        |
| key injection     | ✅¹      | ⚠️       | ⚠️       | ❔        | ❔        |
| power standby     | ⏭️       | ⚠️       | ⚠️       | ⚠️        | ⚠️        |
| network status    | ✅       | ❔       | ❔       | ❔        | ❔        |
| media transport   | ➖²      | ➖²      | ➖²      | ❔        | ❔        |
| voice pipeline    | ➖³      | ➖³      | ➖³      | ❔        | ❔        |

¹ Via the user-enabled AccessibilityService — no signing. `navigation.available`
reports `ready`; individual keys can still fail when the focused window has no
matching target (see the notes under the report below).
² `adapter-aosp` implements no `MediaControl`, so `has("media")` is false and the
`media_*` tools are hidden — even though the bridge's `getDeviceInfo` advertises
`capabilities.media: true`. Inconsistent: the device-info flag is cosmetic today.
³ `adapter-aosp` exposes no `VoicePipeline`. Android voice would come through the
native bridge, and the WebView page is deliberately not a secure context (see
`apps/aosp-app/README.md`), so Web Speech isn't available there either.

Record firmware version, WebView/Chromium version, and required privileges next
to each result.

---

## AOSP — Android TV emulator (verified 2026-07-30)

First real bring-up run. Produced by `?diag&writes` on an Android TV 34 (x86) AVD
— `AOSP TV on x86`, `soc=unknown` because emulator hardware reports `ranchu` —
with the AccessibilityService enabled.

| Capability | Status | Detail |
|---|---|---|
| init | ✅ |  |
| system.getVolume | ✅ | 33 |
| system.setVolume | ✅ | round-trip ok (restored to 33) |
| system.getMute | ✅ | false |
| system.getInputSource | ✅ | app |
| system.setInputSource | ⏭️ | vendor-gated; not auto-exercised |
| system.powerStandby | ⏭️ | destructive; never auto-run |
| apps.listInstalledApps | ✅ | 7 apps |
| apps.findAppsByName | ✅ | 3 match(es) for "a" |
| apps.getForegroundApp | ✅ | none |
| navigation.available | ✅ | ready |
| navigation.sendKey | ⚠️ | Not supported: key 'ok' via accessibility (not every key is reachable this way) |
| network.isOnline | ✅ | true |
| network.connectionType | ✅ | ethernet |
| storage.roundTrip | ✅ | ok |
| media | ⚠️ |  |
| voice | ⚠️ |  |

summary: `{"ok":12,"unsupported":3,"error":0,"skipped":2}`

**Acceptance run** — `node tools/device-acceptance.mjs` against the offline
scripted brain (`tools/mock-llm-server.mjs`): **PASS**. The tool sequence matched
the CI baseline exactly (`set_volume, get_volume, set_volume, set_mute,
search_app_by_name, launch_app, get_volume`), the Chinese variants replied in
Chinese, and no agent errors were raised.

### Platform behaviours worth knowing (not bugs)
- **Volume is quantized.** Android exposes 0..`getStreamMaxVolume` (commonly 15 or
  25 steps), so the HAL's 0-100 scale can't represent every value: "set volume to
  30" reads back as 33 here. The bridge rounds rather than truncates, which keeps
  the error under one step instead of compounding across relative adjustments.
- **Mute collapses the volume readback.** `AudioManager` reports 0 for a muted
  stream, so right after "mute" the agent answers "The volume is 0", where the
  mock adapter keeps volume and mute independent. Unmuting restores the level.
- **`sendKey` depends on what has focus.** The AccessibilityService moves
  directional focus and clicks the focused node; on a page with no focusable
  target (the `?diag` report, for instance) `ok` legitimately fails while
  `navigation.available` still reports ready.
- **`getInputSource` returns `app`** — the emulator has no HDMI inputs.

## Generating results with the self-diagnostic

Don't fill this by hand — run the built-in capability probe on the device and
paste its output.

**On device:** build and install the app (see the platform bring-up guides),
then open it with the `?diag` query flag (append `&writes` to also exercise
volume set/restore and a key press):

- Tizen: launch with a URL containing `?diag`, or set the app's start URL to
  `index.html?diag`.
- AOSP: pass the page as an intent extra (note the escaped `&`, which the device
  shell would otherwise treat as "run in background"):
  ```bash
  adb shell am start -n tv.aiagent.harness/.MainActivity -e start 'index.html?diag\&writes'
  ```

The screen renders a Markdown table (capability, status, detail) plus a summary.
Copy the per-device block into this file. The report is also written to the
console, so you can take the text instead of a screenshot:

```bash
adb logcat -d -s chromium:I        # AOSP; Web Inspector / ares-inspect elsewhere
```

Then run the acceptance script against the same device to check behaviour, not
just capability:

```bash
node tools/mock-llm-server.mjs &                 # offline brain over HTTP
adb reverse tcp:8080 tcp:8099                    # device 127.0.0.1:8080 → host
node tools/device-acceptance.mjs                 # compares against the CI baseline
```

**Locally (mock adapter, for sanity):**

```bash
pnpm build && node tools/diagnostics.mjs --writes
```

The probe is read-only by default; mutating checks (volume set/restore, key
press) run only with the `writes` flag, and standby is never auto-run.
