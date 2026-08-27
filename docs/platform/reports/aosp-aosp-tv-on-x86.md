## AOSP TV on x86 — aosp 14 (reported 2026-08-27)

_Kept as an example of the shape a report takes. It is an emulator, which is
worth less than a retail TV and more than a guess._

**Device**: AOSP TV on x86 · aosp 14 · soc=unknown

**Capability probe**: 13 ok · 2 unsupported · 0 error · 3 skipped

| Capability | Status | Detail |
|---|---|---|
| init | ✅ |  |
| system.getVolume | ✅ | 13 |
| system.setVolume | ✅ | round-trip ok (restored to 13) |
| system.getMute | ✅ | false |
| system.getInputSource | ✅ | app |
| system.setInputSource | ⏭️ | vendor-gated; not auto-exercised |
| system.powerStandby | ⏭️ | destructive; never auto-run |
| apps.listInstalledApps | ✅ | 6 apps |
| apps.findAppsByName | ✅ | 3 match(es) for "a" |
| apps.getForegroundApp | ✅ | none |
| navigation.available | ⏭️ | not ready — enable the accessibility service (navigation.requestSetup) |
| navigation.sendKey | ⛔ | Not supported: navigation — enable the accessibility service first (navigation.requestSetup) |
| network.isOnline | ✅ | true |
| network.connectionType | ✅ | ethernet |
| storage.roundTrip | ✅ | ok |
| media | ⛔ |  |
| voice | ✅ | advertised |
| voice.engines | ✅ | SpeechRecognition (STT), webkitSpeechRecognition (STT), native bridge (Android) |

**Withdrawn on this device** — offered by the catalogue, refused by the hardware:

- `tv.input.switch` — reported unsupported

### Goal mode

**“switch to hdmi2”** → `input_switched`

- `tv.input.switch(source=hdmi2)` — **unsupported** — setInputSource (needs a platform signature on most builds)
- _This TV can't tv.input.switch(source=hdmi2): setInputSource (needs a platform signature on most builds)_

**“play ps5”** → `gaming_session_active`

- nothing runnable — out of reach: devices.ps5.power, tv.input
- _I can't do that on this TV: devices.ps5.power, tv.input._

**“turn it down”** → `volume_reduced`

- `tv.audio.set_volume(level=3)` — **verified**
- _Done: tv.audio.set_volume(level=3)._

**“movie night”** → `movie_night_active`

- nothing runnable — out of reach: content.state
- _I can't do that on this TV: content.state._

### Did anything accept a command and then do nothing?

Nothing detected in this run. (Only actions with a read-back can answer this;
anything reported `unverified` above is a case where the device cannot say.)

### The room

```
Living Room
  AOSP TV on x86 [tv] — built in · 100% · manual+platform
  PlayStation 5 [ps5] — HDMI2 · 100% · manual
  Set-top box [stb] — HDMI3 · 100% · manual
```

### Notes

- collected by tools/device-report.mjs with ?plan&confirm=auto&room=demo
- the PS5/STB in the room below are seeded by `?room=demo`, not real hardware

