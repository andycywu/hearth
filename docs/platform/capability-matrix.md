# The Hearth Report

**What a television can actually do — one verified device at a time.**

This is the project's main output. The runtime is how the answers are collected;
this page is the answer. Nobody can buy twenty TVs across five firmware
generations, and no amount of further software will produce this table — only
people with different televisions in different living rooms can.

## What is covered so far

| Device | How | What it settled |
|---|---|---|
| Android TV 34 emulator | `?diag`, `?plan`, acceptance run | 12 ok / 0 errors. Input switching refused (platform signature). Volume is quantised to 15 steps — which broke exact-match verification until a tolerance was added. |
| Samsung Tizen TV 10.0 emulator | `?diag`, `?demo` | **No audio API at all** — neither `webapis.audiocontrol` nor `tizen.tvaudiocontrol` exists. Apps, storage and network pass. |
| webOS TV 26 simulator | install + boot | Network is real; audio and app management are Luna stubs. Found that `webOS.service.request` is not a platform global. |
| Ubuntu 26.04 (real machine, real sound card) | CI + by hand | All three audio backends verified. No TV inputs, and it says so. |
| **Your TV** | see below | — |

Nothing in the table below is claimed for hardware that has not run it. `❔`
means untested, and untested stays untested until somebody pastes a report.

## Add your device

The most valuable contribution to this project needs no code. On Android TV it
is one command:

```bash
node tools/device-report.mjs
```

That launches the app in goal mode, runs the capability probe and the four
scenarios, and writes a finished section into
[`reports/`](reports/) — no editing, no reformatting. Paste it into an issue or
open a PR adding it to this page.

Anywhere else (Tizen, webOS, a platform with no adb): open the app and ask the
page directly, in the WebView console —

```js
(await window.__hearthReport({ allowWrites: true })).markdown
```

— or, with no tooling at all, launch with `?diag&writes` and copy the capability
table it prints. It is already markdown. Then, if you can, launch with
`?plan&room=demo&confirm=auto&ask=…` and copy the `[plan]` lines: that shows
whether a *plan* survives on your firmware, not just whether an API exists.

What makes a report useful: the exact model and firmware version, the WebView or
Chromium version, and — above all — **what the device did rather than what it
returned**. A capability that answered `ok` and changed nothing is the single
most valuable row anyone can contribute, because it is the one no adapter can
self-report.

Legend: ✅ works · ⚠️ needs partner/platform/system signing · ❔ untested · ➖ n/a

**POC-safe rows (no signing needed):** volume, mute, list/launch apps, network,
navigation, media. The ⚠️ rows (input source, key injection, power standby) are
deferred until a self-signed eng board — see [`../POC.md`](../POC.md).

| Capability        | AOSP emu | AOSP+MTK | AOSP+NVT | Tizen+MTK | Tizen+NVT |
|-------------------|----------|----------|----------|-----------|-----------|
| set/get volume    | ✅       | ❔       | ❔       | ❔⁴       | ❔⁴       |
| mute              | ✅       | ❔       | ❔       | ❔⁴       | ❔⁴       |
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
³ Stale as written: `adapter-aosp` *does* expose a `VoicePipeline` now, through
the native bridge, and it is verified in both directions on the Android TV
emulator. Web Speech is still unavailable in that WebView — the page is
deliberately not a secure context (see `apps/aosp-app/README.md`) — which is
exactly why the bridge exists.

⁴ Not merely untested — **unexercised**. The Tizen TV 10.0 emulator has neither
`webapis.audiocontrol` nor `tizen.tvaudiocontrol` (both globals read
`undefined`), so no audio code path on that platform has ever run. The adapter
reports this as `unsupported` rather than failing, and `?diag` prints which API
it looked for. See [`../HARDWARE_VERIFICATION.md`](../HARDWARE_VERIFICATION.md).

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

### Goal mode on the device (verified 2026-08-18)

Launched with `?plan&room=demo&confirm=auto` and driven by `?ask=`, on the same
Android TV 34 emulator. Plan lifecycle is logged to logcat under `[plan]`, the
room under `[devices]`.

| Utterance | Plan | Outcome |
|---|---|---|
| turn it up | `tv.audio.set_volume(level=10)` | **verified** — read-back agreed |
| turn it down / night mode | *(nothing runnable)* | `achieved=true` — already at or below the level asked for |
| play ps5 | `tv.input.switch(source=hdmi2)` | **unsupported** — "setInputSource (needs a platform signature on most builds)"; capability withdrawn |
| movie night | *(nothing runnable)* | this build advertises no `media`, so the goal is honestly out of reach |

The device graph came up as expected — `PlayStation 5 [ps5] — HDMI2 · 100% ·
manual` beside `AOSP TV on x86 [tv] — built in · 100% · manual+platform` — and
`hdmi2` reached the plan by lookup, not by being written anywhere.

Two defects only a real device could produce, both fixed:

- **Verification failed on quantised volume.** "turn it down" from 33 asked for
  23, Android set step 3 of 15 and read back 20, and exact equality reported *the
  device did not end up in the expected state* about a TV that had done precisely
  what it was asked. The quantisation is documented three bullets above this and
  the verification layer ignored it. Read-back verification now carries a
  tolerance (`StatePredicate.within`), and a relative goal is expressed as a bound
  (`lte` / `gte`) rather than an exact value — a tolerance on the *goal* was the
  first attempt and was worse, because it made a small change a no-op.
- **The world believed the request rather than the reading.** After a verified
  read-back the executor was overwriting the observed value with the requested
  one, so the world said 23 while the TV was at 20. A read-back is now
  authoritative: the observation stands.

## Tizen — Samsung TV 10.0 emulator (verified 2026-08-03)

Everything under `tizen.*` works: 84 apps listed, `getForegroundApp`, `sendKey`,
storage round-trip, and — after the fallbacks below — volume and mute.
`?diag&writes` reports `system.setVolume ✅ round-trip ok`.

Three things about this image are worth knowing before you lose a day to them.

- **The query string never reaches the app.** `<content src="index.html?demo"/>`
  in config.xml is silently stripped by the web runtime, so `location.search` is
  empty and every launch flag is ignored — with no error anywhere. Flags travel
  as `__AGENT_FLAGS__` instead (`packages/core/src/launch-flags.ts`), written by
  `pnpm package:tizen --flags …`. The status line prints `flags:baked…` or
  `flags:none` so you can see which happened.
- **Samsung's `webapis` is absent.** Not a CSP problem (identical with the meta
  tag removed) and not the app profile (Samsung's own SDK template also uses
  `<tizen:profile name="tv"/>`). It ships on the device, not in the SDK, and
  this image doesn't have it — so `webapis.audiocontrol`, `productinfo` and
  `tvinfo` are all undefined. The adapter prefers them where present, since
  retail Samsung TVs have them, and falls back to `tizen.tvaudiocontrol` and
  `tizen.systeminfo`.
- **The emulator has no outbound network.** Both a loopback port tunnelled with
  `sdb reverse` and a public HTTPS endpoint fail with `TypeError: Failed to
  fetch`; `?diag&reach` shows both. So a model endpoint can't be reached from
  this image and the agent can only run against the scripted brain here. Note
  `network.isOnline` still reports `true`: `navigator.onLine` doesn't know about
  routes, which is exactly why the reach probe exists. Details and the full
  elimination below — the short version is that it is not anything you can fix
  in the app.

`sdb shell` answers `closed` on this image and the Web Inspector port refuses
connections, so the screen is the only way to read anything back — hence
`tools/capture-window.ps1`.

### Voice, and a correction (measured 2026-08-05)

I assumed voice on Samsung TV would need Bixby and a partner agreement. On this
image that is **wrong**: the Tizen WebView is Chromium and `?diag` reports

```text
voice.engines ✅ speechSynthesis (TTS, 4 voices), webkitSpeechRecognition (STT)
```

so the adapter now uses the shared Web Speech pipeline and reports
`voice ✅ advertised`. No native code, no vendor relationship.

What that does and doesn't establish:

- **Four synthesis voices are installed**, so TTS should genuinely speak rather
  than being a mute API. The voice count is in the probe precisely because an
  engine with zero voices looks identical to a working one from JS.
- **`webkitSpeechRecognition` existing is not the same as it working.**
  Chromium's implementation ships audio to a cloud service, and this emulator has
  no outbound network at all (see above), so recognition here will exist and then
  fail. Whether a retail Samsung TV has a working recognition backend is still
  unverified.
- webOS is wired the same way on the same reasoning, but is **untested** — it
  still has no install target.

Android is the exception and goes through the native bridge instead: our WebView
is deliberately not a secure context (the app is served over http so a local
model is reachable), which rules Web Speech out there.

### Why the emulator can't reach the network (investigated 2026-08-04)

Worth writing down because the obvious suspects are all wrong, and checking
them costs most of a day. **Do not start with proxy or bridge settings.**

There are two *different* faults, one per image. Both are inside the emulator;
neither is fixable from the app, the host network, or the Emulator Control
Panel.

**Generic Tizen image (`profile=tizen`) — the guest has no network interface.**
Its kernel log (`sdk-data/emulator/vms/<vm>/logs/emulator.klog`, written by the
`-chardev file` in `vm_launch.conf`) contains zero occurrences of `eth0`, zero
of `virtio_net`, and no link-up line. QEMU offers the NIC
(`-netdev user,id=net0` + `-device virtio-net-pci`) and nothing binds to it.
Consistent with the host-side observation below: no packet is ever generated,
so there is nothing to route, block or proxy.

**Samsung TV image (`profile=tv-samsung`) — the guest is fine; slirp never even
tries to connect out.** The same log shows a fully configured stack:

```text
Interface [eth0]   ipv4(10.0.2.15)   Gateway [10.0.2.2]   proxy((null))
```

That address came from slirp's own DHCP, so slirp is alive and talking to the
guest. Outbound TCP still fails, and the Control Panel's *User Network
Information* table shows the connection stuck in `TCP[SYN_RCVD]` — slirp took
the guest's SYN and never completed the host side. The socket count below
confirms it never even started: **zero** outbound sockets from the emulator
process while two fetches were pending. Measured on both images, and on both
host network states (Wi-Fi only, and wired with the corporate VPN up), so it
does not depend on the host's network at all.

**Ruled out, each with evidence** (so nobody repeats this):

| Suspect | Why it isn't that |
|---|---|
| Proxy | `network_proxy=""` in `vm_launch.conf`; the guest's own env logs `http_proxy=` empty with `no_proxy=localhost,127.0.0.1/8,10.0.2.0/24`; and the host has no proxy at all (`netsh winhttp show proxy` → direct, `ProxyEnable=0`). Three independent sources. |
| TAP / bridge | All TAP adapters stay `Disconnected` *while the emulator runs*, and no Network Bridge exists. NAT mode doesn't use them. Accumulated TAP adapters are leftovers from repeated **Create tap** clicks in the Network tab. |
| Host firewall / VPN | Nothing ever leaves the emulator process, so there is nothing to block. No firewall rule references the emulator binary either. Re-measured with the corporate VPN (GlobalProtect) both down and up: identical. |
| CSP | Identical results with the `Content-Security-Policy` meta tag removed entirely. |
| DNS | A raw-IP URL (`http://10.0.2.2:8080/…`) fails exactly like a hostname. |
| Our code | The same build passes on the Android TV emulator, including the model round-trip. |

The decisive host-side measurement: with `?diag&reach` running two fetches,
poll `netstat -ano` for the emulator's PID. A working slirp opens an outbound
socket per guest connection. There were **zero** on either image, over a 30-second
window, on verified-fresh app starts. Verify the run really is
fresh: `tz run` on an already-running app only brings it to the front, so
reinstall first and confirm the report changed (packaging without `reach` and
watching the two rows disappear is a good control).

**Why Android is unaffected:** `adb reverse` tunnels through the adb transport,
not the guest's IP stack, so the emulator's NAT is never involved. Tizen's
`sdb reverse` registers a mapping (`sdb reverse --list` shows it) but does not
forward — so there is no equivalent escape hatch, and note the argument order
is `<device-port> <host-port>`, the opposite of what `--list`'s "LOCAL" column
suggests.

**Checked against Samsung's own documentation** ([emulator-features.md](https://github.com/Samsung/tizen-docs/blob/master/docs/application/tizen-studio/common-tools/emulator-features.md),
the source the docs site renders), because it settles what is a fault and what
is by design:

- NAT is the default backend and "exploits the QEMU user networking (SLIRP)".
  The virtual LAN is `10.0.2.2` gateway/host, `10.0.2.3` DNS, `10.0.2.15`
  emulator — matching what the guest log reports, so the addressing is right.
- "The emulator supports TCP, UDP, and ping within a guest. However, a raw
  socket is not supported." **"Inbound connections from external to the
  emulator fail in the NAT backend."** Inbound and raw sockets are the *only*
  documented limits: outbound is supposed to work, so our failure is a fault
  rather than a design constraint.
- Port forwarding is host→guest, which is the opposite of what a model endpoint
  needs, so the Control Panel's *Add port-forwarding* is not the answer here.
- **"Network bridging does not work when the underlying physical network device
  is a wireless device."** On a laptop with only Wi-Fi up, bridge mode is not
  an option at all — which is why repeated **Create tap** clicks leave orphaned
  TAP adapters and never produce a Network Bridge. Don't go down this path
  without a cable.

And the VM's own `vm_config.xml` matches the documented defaults —
`netConnectType=NAT`, `hostIp=10.0.2.2`, `useDHCP=on`, `netDns=""` (i.e. the
default `10.0.2.3`), `netTapDevice=""`. One cosmetic oddity: `proxyMode=auto`,
which the docs call unsupported ("Automatic proxy configuration is not
supported due to licensing issues") — but it ships that way in the SDK's own
templates, and the proxy is only ever injected as guest environment variables,
which the guest log shows empty. So it is not the cause; nothing here is
misconfigured.

**What this means in practice: nothing, for the demo.** `?demo` with no `?llm=`
runs the whole agent loop against the offline brain in the bundle, so the broken
NAT costs nothing there — verified on the Samsung image, all eight commands,
with `?diag` afterwards reading `getVolume ✅ 50`, the value the demo's Japanese
step set. Only pointing at a *real* model needs the network, and that needs
either a network-capable image or a retail TV in Developer Mode — worth doing
anyway, since that is also where `webapis` actually exists.

Chasing this fault was mostly wasted effort: the demo never needed the network,
our own hosts did. Check whether the thing you're trying to demo actually
requires the broken capability before spending a day on the capability.

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
