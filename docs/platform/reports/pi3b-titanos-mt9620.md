## Raspberry Pi 3 Model B Rev 1.2 (wireplumber) — linux Debian GNU/Linux 13 (trixie) · 6.18.50+rpt-rpi-v8 (reported 2026-10-05)

**Device**: Raspberry Pi 3 Model B Rev 1.2 (wireplumber) · linux Debian GNU/Linux 13 (trixie) · 6.18.50+rpt-rpi-v8 · soc=broadcom

**Capability probe**: 12 ok · 3 unsupported · 0 error · 3 skipped

| Capability | Status | Detail |
|---|---|---|
| init | ✅ |  |
| system.getVolume | ✅ | 20 |
| system.setVolume | ✅ | round-trip ok (restored to 20) |
| system.getMute | ✅ | true |
| system.getInputSource | ✅ | app |
| system.setInputSource | ⏭️ | vendor-gated; not auto-exercised |
| system.powerStandby | ⏭️ | destructive; never auto-run |
| apps.listInstalledApps | ✅ | 30 apps |
| apps.findAppsByName | ✅ | 15 match(es) for "a" |
| apps.getForegroundApp | ✅ | none |
| navigation.available | ⏭️ | not ready — enable the accessibility service (navigation.requestSetup) |
| navigation.sendKey | ⛔ | Not supported: key injection — needs xdotool (X11) or ydotool (Wayland, plus uinput access) |
| network.isOnline | ✅ | true |
| network.connectionType | ✅ | wifi |
| storage.roundTrip | ✅ | ok |
| media | ⛔ |  |
| voice | ⛔ |  |
| voice.engines | ✅ | none detected |

**Withdrawn on this device** — offered by the catalogue, refused by the hardware:

- `tv.input.switch` — reported unsupported

### Goal mode

**“switch to hdmi2”** → `input_switched`

- `tv.input.switch(source=hdmi2)` — **unsupported** — switching input — this device has no TV inputs to switch between
- _This TV can't tv.input.switch(source=hdmi2): switching input — this device has no TV inputs to switch between_

**“play ps5”** → `gaming_session_active`

- nothing runnable — out of reach: devices.ps5.power, tv.input
- _I can't do that on this TV: devices.ps5.power, tv.input._

**“turn it down”** → `volume_reduced`

- `tv.audio.set_volume(level=10)` — **verified**
- _Done: tv.audio.set_volume(level=10)._

**“movie night”** → `movie_night_active`

- nothing runnable — out of reach: content.state
- _I can't do that on this TV: content.state._

### Did anything accept a command and then do nothing?

Nothing detected in this run. (Only actions with a read-back can answer this;
anything reported `unverified` above is a case where the device cannot say.)

### Planning cost

4 plan(s), **100% needed no model** — deterministic 4, model 0, remote 0, fallback 0, chat turns 0.

### The room

```
Living Room
  Raspberry Pi 3 Model B Rev 1.2 (wireplumber) [tv] — built in · 100% · platform
  PlayStation 5 [ps5] — HDMI2 · 100% · manual
  Set-top box [stb] — HDMI3 · 100% · manual
```

### Notes

- hearth 0.3.0 CLI on Node v26.8.2; room seeded as `demo`
- probe ran with writes: one volume round-trip was performed
- gated steps were approved automatically (`--yes`)
- transport: cec: bus present, no reachable devices
- **Taken with v0.3.0+26ccba2 and read against the box afterwards.** Two rows above
  are wrong about the box, not about the run, and both were fixed the same day:
  `voice ⛔ / voice.engines: none detected` — the box has `arecord` and `espeak-ng`;
  the CLI only wired voice with `--voice`, and core's engine detection looks for
  browser APIs. `navigation.available: enable the accessibility service` — that
  is an Android setting; on a Pi the honest answer is "not available".
- **The television is a Titan OS set on a MediaTek MT9620** — not the HKC
  Tizen set the 2026-09-16 CEC run used. `cec-ctl` sees the Pi at `3.0.0.0`
  (HDMI 3) and the TV at `0.0.0.0`, CEC 1.4, `Vendor ID: 0x00903e (Philips)`,
  OSD name `TV`, menu language `eng`, power `On`. Philips is what a TPV-built
  Titan OS set should answer. This is the first time this project has touched
  a Titan OS television at all — from the outside, over the bus, with no app
  installed on it. The TV answered `<Give Device Power Status>` for itself
  (`On`); whether it would answer for a *standby* change is the M2 question.
- Node 26.8.2 lives in `~/.local/node/bin`, on PATH only through `.profile`; a
  non-interactive ssh — and a systemd unit — starts without it.

