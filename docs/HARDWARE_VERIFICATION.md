# What still needs a real TV

_Last updated: 2026-08-11_

An emulator proves the code runs. It does not prove the code is right, because
the thing an emulator is least faithful about is **the hardware you are trying
to control**. This page says, per OS, exactly which claims are backed by a real
device and which are not — so nothing is a surprise on the day a box arrives.

The rule of thumb this project keeps re-learning: **anything the emulator does
not have, the emulator cannot test, and its silence reads exactly like success.**

## The short answer

| OS | State | What a real device is for |
|----|-------|---------------------------|
| **Tizen** | Emulator only | **All audio.** The emulator has no audio API at all, so volume and mute have never run. Plus Samsung's whole `webapis.*` surface, and retail signing. |
| **webOS** | Simulator, first run | Audio and app management — the simulator stubs those Luna services. Plus partner APIs and a real TV's method names. |
| **Android TV / AOSP** | Emulator, thoroughly | Input switching, standby, real remotes, real apps, and MTK/NVT performance. |
| **Linux** | Real machine ✅ | Nothing outstanding — verified on Ubuntu with a real sound card. |

---

## Tizen — the biggest gap

Verified on the TV 10.0 emulator: install, launch, app list, storage, network
status, the UI, and a real LLM driving tool calls.

**Not verified, because the emulator physically cannot:**

| Capability | Why the emulator can't answer |
|---|---|
| **Volume** | Neither `webapis.audiocontrol` nor `tizen.tvaudiocontrol` exists on this build. Confirmed by reading the globals: both `undefined`. |
| **Mute** | Same API, same absence. |
| Model / OS version / SoC | `webapis.productinfo` absent — the emulator reports model `Emulator`, soc `unknown`. |
| Real network status | `webapis.network.isConnectedToGateway` absent; the adapter falls back to `navigator.onLine`. |
| Current input source | `webapis.tvinfo.getCurrentSource` absent. |
| Input switching, standby | Not implemented — Samsung partner API. |
| Speech recognition | `webkitSpeechRecognition` *exists* on the emulator, but with no microphone it has never been exercised. Presence is not proof. |
| Remote key codes | Samsung's codes (back `10009`, etc.) are dispatched as synthetic events; no real remote has pressed them. |
| Retail signing | Everything so far is signed `tizen-dev`. A retail TV needs a Samsung partner certificate and Developer Mode. |

**The specific risk:** the adapter prefers Samsung's `webapis.audiocontrol` and
falls back to the standard `tizen.tvaudiocontrol`. On the emulator *neither*
path runs, so both are unexercised code. The first time either one executes
will be on your TV.

**What to do first on a real Samsung TV:** open `?diag`. That page reports which
audio API was found, verbatim. If it still says "no audio control API on this
build", the host page is missing
`<script src="$WEBAPIS/webapis/webapis.js">` — the message names the fix.

## webOS — runs now, on a simulator that stubs most of the bus

Verified on the webOS TV 26 Simulator (1.5.0): the app installs into the app
bar, launches, boots the agent, reports `webos` / `WEBOS26_SIMULATOR`, and
network status comes back from the real Luna service bus.

That first run immediately found the reason none of this had ever worked:
`webOS.service.request` is **not** a platform global. It ships in LG's
webOSTV.js, which the *app* must include, and this one did not — so every
capability threw `ReferenceError: webOS is not defined`. The adapter now falls
back to `WebOSServiceBridge`, the native object that library wraps, so nothing
needs to be bundled.

| Capability | State on the simulator |
|---|---|
| Network status / connection type | ✅ real answers from `com.palm.connectionmanager` |
| Volume, mute | ⛔ `com.webos.audio` exists but answers "Unknown method" — the simulator stubs it |
| App list, launch, foreground app | ⛔ same, `com.webos.applicationManager` is a stub |
| Input switching, standby | ⛔ LG partner APIs, not implemented |
| Voice | Web Speech detected; no microphone, so unexercised |
| Remote key codes | Synthetic events only; no real magic remote has been used |

**What a real LG TV is for:** confirming the Luna method names for audio and
app management. Ours are unverified against a device — the simulator can only
say "that service is a stub here", which is not the same as "your URI is
wrong". Both are plausible and only a TV can separate them.

**Note for whoever runs the simulator next:** it is an Electron app, and it
exits instantly with status 0 if `ELECTRON_RUN_AS_NODE` is set in the
environment — which some editor-integrated terminals do set. If it seems not to
launch at all, that is why. Launch it with
`ares-launch <appDir> -s 26 -sp <simulatorDir>`.

## Android TV / AOSP — verified, with named exceptions

The best-covered target. Verified on the emulator: volume and mute (read back
from `dumpsys audio`, not from our own return values), app list and launch,
storage across restarts, voice in both directions through the native bridge,
the translucent overlay, the confirmation gate, and a real local model
completing tool-calling turns.

**Still needs a box:**

| Capability | Why |
|---|---|
| Input switching | `setInputSource` needs a platform signature on most builds. |
| Standby | `powerStandby` needs the `DEVICE_POWER` system permission. |
| HDMI / CEC, real inputs | The emulator has no HDMI ports to switch between. |
| Real remote buttons | We bind `KEYCODE_SEARCH` / `VOICE_ASSIST` / `MEDIA_RECORD`. Which one an OEM's mic button actually sends varies, and only that remote can tell you. |
| Real streaming apps | Package ids differ per device. "Open Netflix" resolves against whatever is installed. |
| Far-field microphone | Emulator audio is a desktop mic at 30cm, not a TV mic at 3m. |
| Translucency over live TV | Verified over the emulator's launcher. Over a live broadcast the contrast is a different problem. |
| MTK / NVT performance | The emulator is desktop x86. Frame rate, memory and model latency on real silicon are unmeasured. |

## Linux — done

Verified on a real Ubuntu 26.04 VM with a working sound card: all three audio
backends (`wpctl`, `pactl`, `amixer`), every write confirmed by reading the
value back. `pactl` and `wpctl` also run in CI on every push. Input switching
and standby correctly report "this device has no TV inputs".

---

## Two things that were only found by leaving the emulator

Worth stating because they set the expectation for what a real TV will turn up.

**Tizen could not reach any network host, ever.** `config.xml` declared the
`internet` privilege but no `<access>` origin, and the Widget Access Request
Policy denies everything without one. Every model call failed as a bare
`TypeError: Failed to fetch`. The emulator's own shell could `curl` the same
endpoint and get 200 — that gap is what identified it. This was in the shipped
app and would have failed identically on a retail TV.

**The tool schema was invalid JSON Schema.** Each property carried
`required: true`, which JSON Schema reserves for an array on the parent object.
OpenAI ignores it; Ollama rejects the whole request, so the agent could not call
a single tool. The offline client never sees a schema, so no test and no
emulator could have caught it — the existing test asserted the broken shape as
correct.

Both are fixed. Both are the same shape of bug: **something that only executes
when a real counterpart is on the other end.** Expect more of those on the first
real TV, and prefer bring-up steps that read state back from the device rather
than trusting a return value.
