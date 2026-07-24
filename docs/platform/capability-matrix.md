# Capability matrix (fill during Phase 2 bring-up)

Legend: ✅ works · ⚠️ needs vendor SDK / system privilege · ❔ untested · ➖ n/a

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
