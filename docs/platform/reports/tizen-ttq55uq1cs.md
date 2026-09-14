## TTQ55UQ1CS — tizen TIZEN-LICENSE-TV-2023-MP-NVT-LICENSE-HOTFIX-RELEASE_20260421.1 (reported 2026-09-14)

**Device**: TTQ55UQ1CS · tizen TIZEN-LICENSE-TV-2023-MP-NVT-LICENSE-HOTFIX-RELEASE_20260421.1 · soc=unknown

**Capability probe**: 16 ok · 0 unsupported · 0 error · 2 skipped

| Capability | Status | Detail |
|---|---|---|
| init | ✅ |  |
| system.getVolume | ✅ | 15 |
| system.setVolume | ✅ | round-trip ok (restored to 15) |
| system.getMute | ✅ | false |
| system.getInputSource | ✅ | tv |
| system.setInputSource | ⏭️ | vendor-gated; not auto-exercised |
| system.powerStandby | ⏭️ | destructive; never auto-run |
| apps.listInstalledApps | ✅ | 279 apps |
| apps.findAppsByName | ✅ | 196 match(es) for "a" |
| apps.getForegroundApp | ✅ | Hearth |
| navigation.available | ✅ | assumed (always available) |
| navigation.sendKey | ✅ | sent 'ok' |
| network.isOnline | ✅ | true |
| network.connectionType | ✅ | wifi |
| storage.roundTrip | ✅ | ok |
| media | ✅ | advertised |
| voice | ✅ | advertised |
| voice.engines | ✅ | speechSynthesis (TTS, 19 voices), webkitSpeechRecognition (STT) |

**Withdrawn on this device** — offered by the catalogue, refused by the hardware:

- `tv.input.switch` — reported unsupported

### Goal mode

**“switch to hdmi2”** → `input_switched`

- `tv.input.switch(source=hdmi2)` — **unsupported** — setInputSource on this firmware
- _This TV can't tv.input.switch(source=hdmi2): setInputSource on this firmware_

**“play ps5”** → `gaming_session_active`

- nothing runnable — out of reach: devices.ps5.power, tv.input
- _I can't do that on this TV: devices.ps5.power, tv.input._

**“turn it down”** → `volume_reduced`

- `tv.audio.set_volume(level=5)` — **verified**
- _Done: tv.audio.set_volume(level=5)._

**“movie night”** → `movie_night_active`

- `content.resume()` — **unverified** — no playback-state read in the HAL yet
- _Asked the TV to content.resume, but this device can't confirm it._

### Did anything accept a command and then do nothing?

Nothing detected in this run. (Only actions with a read-back can answer this;
anything reported `unverified` above is a case where the device cannot say.)

### Planning cost

4 plan(s), **100% needed no model** — deterministic 4, model 0, remote 0, fallback 0, chat turns 0.

### The room

```
Living Room
  TTQ55UQ1CS [tv] — built in · 100% · platform
  PlayStation 5 [ps5] — HDMI2 · 100% · manual
  Set-top box [stb] — HDMI3 · 100% · manual
```

### Notes

- collected by tools/device-report-tizen.mjs over the Web Inspector (launched with `0 debug tvaiagent0.tizen-app`)
- launch flags baked into this package: plan&confirm=auto&room=demo
- audio control API present on this build: tizen.tvaudiocontrol (standard)
- the PS5/STB in the room section are seeded by `room=demo`, not real hardware
- no independent volume readback (vconftool absent or a different key on this build) — volume figures below are the adapter reporting on itself

