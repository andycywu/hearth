# Capability matrix (fill during Phase 2 bring-up)

Legend: ✅ works · ⚠️ needs partner/platform/system signing · ❔ untested · ➖ n/a

**POC-safe rows (no signing needed):** volume, mute, list/launch apps, network,
navigation, media. The ⚠️ rows (input source, key injection, power standby) are
deferred until a self-signed eng board — see [`../POC.md`](../POC.md).

| Capability        | AOSP+MTK | AOSP+NVT | Tizen+MTK | Tizen+NVT |
|-------------------|----------|----------|-----------|-----------|
| set/get volume    | ❔       | ❔       | ❔        | ❔        |
| mute              | ❔       | ❔       | ❔        | ❔        |
| list apps         | ❔       | ❔       | ❔        | ❔        |
| launch app        | ❔       | ❔       | ❔        | ❔        |
| input source      | ⚠️       | ⚠️       | ⚠️        | ⚠️        |
| key injection     | ⚠️       | ⚠️       | ❔        | ❔        |
| power standby     | ⚠️       | ⚠️       | ⚠️        | ⚠️        |
| network status    | ❔       | ❔       | ❔        | ❔        |
| media transport   | ❔       | ❔       | ❔        | ❔        |
| voice pipeline    | ❔       | ❔       | ❔        | ❔        |

Record firmware version, WebView/Chromium version, and required privileges next
to each result.

## Generating results with the self-diagnostic

Don't fill this by hand — run the built-in capability probe on the device and
paste its output.

**On device:** build and install the app (see the platform bring-up guides),
then open it with the `?diag` query flag (append `&writes` to also exercise
volume set/restore and a key press):

- Tizen: launch with a URL containing `?diag`, or set the app's start URL to
  `index.html?diag`.
- AOSP: the WebView loads `file:///android_asset/index.html`; append `?diag`.

The screen renders a Markdown table (capability, status, detail) plus a summary.
Copy the per-device block into this file.

**Locally (mock adapter, for sanity):**

```bash
pnpm build && node tools/diagnostics.mjs --writes
```

The probe is read-only by default; mutating checks (volume set/restore, key
press) run only with the `writes` flag, and standby is never auto-run.
