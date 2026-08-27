---
name: Device report (Hearth Report)
about: What a real television actually did — the most useful thing you can send us
labels: device-report
---

<!--
Ten minutes, no code. Everything below is optional except the first two lines —
a partial report beats no report, and "I could not get it to install" is itself
a result worth having.
-->

**Device**: model, OS + version, SoC if you know it, WebView/Chromium version

**How you ran it**: emulator / retail TV / dev board · which build (`.apk`,
`.wgt`, `.ipk`) · signing tier if you know it

### `?diag&writes` output

<!-- Paste the capability table. It is already markdown. -->

### `?plan` output (optional, and the interesting half)

<!--
Launched with `?plan&room=demo&confirm=auto&ask=...`, paste the `[plan]` lines.
This shows whether a plan survives on your firmware, not just whether an API
exists.
-->

### Did anything accept a command and then do nothing?

<!--
The most valuable answer on this form. A call that returned `ok` and changed
nothing is the one thing no adapter can self-report, and it is exactly what the
verification loop exists to catch.
-->

### Anything else

<!-- Privileges required, vendor SDK notes, what you had to do to get it running. -->
