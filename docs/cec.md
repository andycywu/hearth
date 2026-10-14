# HDMI-CEC — the first transport past the television

_Roadmap [task 7](roadmap.md#next-10-implementation-tasks). Packages:
[`packages/adapter-cec`](../packages/adapter-cec) (transport-agnostic) and the
`cec-ctl` transport in [`packages/adapter-linux`](../packages/adapter-linux).
Status: **built, and tested against a mock bus and recorded output; never run
against a real one.**_

Everything before this reached exactly one device. Volume, mute, input, apps —
the television acting on itself through the HAL, where "did it work?" is answered
by asking the same object that just did it. A console on HDMI2 is a different
kind of thing: it has its own power state, its own name, its own idea of what it
received, and it can ignore you in ways the TV cannot.

That makes CEC the first real test of the claim this project is built on. Not
"can we send a message" — that part is easy — but **can we tell the difference
between a console that woke up, a console that woke up and won't say so, and a
console that took the message and stayed asleep.** Those are three different
sentences an agent has to be able to say, and CEC produces all three routinely.

## What the transport is

Six methods, each named after the CEC message it sends
([`types.ts`](../packages/adapter-cec/src/types.ts)):

| Method | Message | What resolving means |
|---|---|---|
| `available()` | — | there is a bus reachable from this process |
| `scan()` | poll + `<Give Physical Address>` / `<Give OSD Name>` / `<Give Device Vendor ID>` | these addresses answered |
| `powerStatus()` | `<Give Device Power Status>` (0x8F) | the device answered, or `"unknown"` if it did not |
| `wake()` | `<Set Stream Path>` (0x86) | **the bus accepted the message** — nothing more |
| `standby()` | `<Standby>` (0x36), addressed | as above |
| `selectSource()` | `<Set Stream Path>` (0x86) | as above |

The interface is message-shaped rather than intent-shaped on purpose. `wake()`
returning is not "the console is on", and an interface that called itself
`turnOn(): Promise<void>` would invite exactly that reading — which is how an
agent's model of the room goes wrong and stays wrong.

### Who can actually implement it

| Host | API | Reachable? | Implemented |
|---|---|---|---|
| Android TV | `HdmiControlManager` | **only with `HDMI_CEC`, which is `@SystemApi`** | no |
| Linux | `/dev/cec0` via `cec-ctl` | yes — a Raspberry Pi and an HDMI cable | **yes**, `createLinuxCecTransport` |
| Tizen / webOS | no public CEC surface | no | no |

That table is the finding, not a footnote. CEC sits behind the same privilege
wall as input switching: on every platform whose image we do not own, a
third-party app gets nothing. `available()` returning `false` is the *normal*
answer, and the runtime is built so that it costs one call at boot and no tools
on the model's menu.

**The consequence for contributors:** the cheapest real CEC verification anyone
can buy is a Raspberry Pi, not a television. That is the one path here that does
not require a partner agreement, and it is where this package should be
exercised first.

## Where it plugs in

Nothing above the transport learns what CEC is:

```
CecTransport ──► createCecSource()     ──► DiscoverySource "hdmi_cec" ──► Device Graph
             └─► createCecTools()      ──► tools ──► Capability Graph ──► planner
```

A host wires it in **one line**, because the boot sequence understands
transports rather than understanding CEC:

```ts
// apps/aosp-app — the day an Android build is signed to reach HdmiControlManager
bootRuntime({ name: "aosp", createAdapter, transports: () => [createCecTransport(bus)] });
```

`DeviceTransport` ([`core/src/devices/transport.ts`](../packages/core/src/devices/transport.ts))
is the seam, and it has two stages because the order matters:

1. **Before the room is built** it offers discovery sources, since what it can
   see is part of what the room *is*.
2. **After the room is built** it is handed the graph and asked what it can now
   do — because the answer depends on what was found, and on what the merge
   decided to call it.

That second stage is the easiest thing here to get subtly wrong. CEC knows a
console as `2.0.0.0`, a person knows it as "the PS5", and a skill resolving
「我要打 PS5」 looks for the latter — so `cecTargets` keys everything by the
*Device Graph node id*, after the merge. Capabilities registered under the CEC
address would produce a plan for a device the goal has never heard of: every step
correct, the whole thing useless.

The attachment returns capabilities **and** tools, because they answer different
questions — a tool is what the model may ask for, a capability is what the
planner may reason about. A transport supplying only tools is invisible to goal
mode; one supplying only capabilities makes plans nothing can execute. That is
what `AgentOptions.capabilities` exists for.

A transport that throws is dropped with a note in the boot log. A CEC adapter
that is not there must never stop a television from booting, and not being there
is the normal case.

Try it in the browser — [`?cec=mock`](https://andycywu.github.io/hearth/?cec=mock)
in the dev harness puts a mock bus behind the demo room, then ask 「我要打 PS5」.
The planner, the policy engine and the world model are unchanged by any of it.

### What CEC tells the Device Graph, and what it refuses to

- **The physical address is topology, and it is exact.** `2.0.0.0` is on the
  TV's HDMI2; `3.1.0.0` is on port 1 of the device at `3.0.0.0`, which is how an
  AVR with a console behind it announces itself. That is the `parentId` hop the
  graph has had a field for since before anything could fill it in — derived from
  the address, with no second discovery pass.
- **The OSD name is usually the truth** and is used as the name.
- **The logical address is a trap.** It is assigned by *function slot*: a
  console, a Blu-ray player and a streaming stick all take a Playback address
  (4, 8 or 11) and which one they get depends on who plugged in first. So it
  gives `tv` for 0 and `avr` for 5, where the spec is unambiguous, and otherwise
  `unknown`. `unknown` on a device we can see and control is a good answer; a
  guessed `game_console` is a fabricated one.

Devices are identified by **physical address, not logical address**: logical
addresses are reallocated when devices come and go, so a console that is 4 today
can be 8 tomorrow and would arrive as a second device. A physical address only
changes when someone moves a cable — and then it *should* be a new node.

## The part that matters: how power gets verified

`createDevicePowerCapabilities` in core already declared `ps5.power.on`. Building
this found that it could **never report `verified`**, and not because of CEC:

> Its verification was `{ kind: "state", predicate: devices.ps5.power = on }`,
> and the executor deliberately refuses to let a step's own optimistic write
> verify it. So a `state` verification is only satisfied by *another* source
> writing that path — a perception event, a different tool, a person. For device
> power there was no such source, so the permanent answer was `unverified`.

CEC is the first transport that can answer the question, because
`<Give Device Power Status>` exists. So the package adds a **read** capability,
`<device>.power.status`, and re-points the writes at it as a `read_back` — the
same shape `tv.audio.set_volume` has always had. The four outcomes then fall out
of the hardware rather than out of a code path:

| The room | The answer |
|---|---|
| the console woke and says `on` | **verified** |
| the console woke and never answers `<Give Device Power Status>` | **unverified** |
| the bus accepted `<Set Stream Path>` and the console is still in standby | **failed** |
| there is no CEC on this platform | **unsupported**, withdrawn, never offered again |

A device reporting *in transition* (0x02 / 0x03) is reported as neither: it is a
real answer and a temporary one, and reporting the state it is heading for is the
same optimism the read-back exists to prevent.

[`power.test.ts`](../packages/adapter-cec/src/power.test.ts) pins all four with
one goal and one plan against four buses. That is the argument of the whole
project in one file — same code, different room, different honest answer.

## The mock bus misbehaves on purpose

[`mock.ts`](../packages/adapter-cec/src/mock.ts) ships a scripted living room
(`MOCK_LIVING_ROOM`: a PS5 on HDMI2, an AVR on HDMI3, an Apple TV behind the AVR)
and three switches for the ways real hardware disappoints you:
`answersPowerStatus: false`, `wakesOnStreamPath: false`, and an absent bus. This
follows `packages/perception-mock`, which ships a deliberately leaky perception
source for the same reason: **a mock that only behaves well is a mock that agrees
with you.**

## What this found in code that was already passing its tests

Three defects, all of the same shape — code that was correct for every device
that had existed so far:

1. **A read-back could verify against its own assumption.** The executor's
   `read_back` branch checked that the read *succeeded*, not that it *answered*.
   Every reader in this repo always answers — a TV that reports its volume at all
   reports a number — so a successful-but-silent read had never happened. Over
   CEC it is ordinary, and the result would have been a confident `verified` for
   a console that never woke: the single worst answer this system can give. Now
   the read-back checks the backing source, exactly as `state` verification
   already did.
2. **Two devices on one HDMI port merged into one.** Device identity fell back to
   the HDMI port, and an AVR at `3.0.0.0` and the box plugged into it at
   `3.1.0.0` are both "on HDMI3", so the room silently lost a device. The
   `cecAddress` field existed on an *observation* and was never stored on a node
   — the documented identity rule named it, and nothing implemented it. It is now
   stored, used ahead of the port, and carried back through persistence.
3. **Two CEC devices could not coexist.** Core names a power tool after its
   *provider*, so a second CEC device also wanted to be `cec_power_on`, and the
   registry throws on a duplicate name. A living room with a console and a
   set-top box was a boot crash. Tool names are now per device.

The boundary claim from the Titan/Xumo task still holds in the way that matters:
no file under `core/src/{world,capabilities,policy}` was touched, and the planner
change was a bug fix, not an accommodation. What CEC needed from core was three
things core had already promised and not delivered.

## The Linux transport, and how to check it

[`packages/adapter-linux/src/cec.ts`](../packages/adapter-linux/src/cec.ts)
implements `CecTransport` over `cec-ctl` (v4l-utils), following the same shape as
that adapter's audio backends: every shell call goes through an injectable
`Runner`, and the parsers are pure so they can be tested against real command
output with no hardware.

Two operational facts that cost time if you do not know them:

- **An adapter must claim a logical address before it can transmit.** A fresh
  `/dev/cec0` has none, and every `--to` transmit fails with "Device has no
  logical address". The transport runs `cec-ctl --playback` once, lazily, before
  its first transmit — and `configure: false` exists for a box where another
  daemon already owns the adapter.
- **CEC is slow.** A topology scan walks up to 15 addresses with a real timeout
  on each. The 5-second runner that is generous for `pactl` is not enough; this
  one waits 15.

**The parsers are tested against fixtures written from `cec-ctl`'s documentation,
not recorded from a device.** That is a weaker thing than it looks like, so the
repo says which it is, and ships the way to fix it:

```bash
node tools/verify-cec.mjs             # read-only: scan, topology, power status
node tools/verify-cec.mjs --writes    # also wake a device and put it back
```

It prints the raw `cec-ctl` output beside what the parser made of it, reports how
many devices answer `<Give Device Power Status>` at all — *only those can ever
report `verified`* — and ends with a transcript ready to paste into
`cec.test.ts`. On a machine with no adapter it says so and exits 0, because not
owning a Pi is not a test failure.

## What is left, and what needs hardware

- **A real bus.** Every claim on this page is a claim about code, not about
  hardware. The first real device will find something; every previous bring-up
  has, and the ones it found were never the ones anyone predicted.
- **An Android `CecTransport`** over `HdmiControlManager`, in the AOSP host's
  native bridge. Needs a platform-signed build to be worth anything, so it is
  behind the same wall as input switching.
- **Multi-provider demotion** (`ps5.power.on` over CEC, then wake-on-LAN, then an
  IR blaster). The executor already tries fallbacks in order and withdraws a
  provider that answers `unsupported`; what is missing is a second transport to
  fall back *to*.

## Testing it by hand: `hearth lab` and `hearth cec`

`tools/verify-cec.mjs` runs a fixed sequence and prints a transcript. When
"the TV does not respond" and nobody can say where the break is, what is wanted
is the opposite: send *one* command, see the exact `cec-ctl` line that went out,
and see what the bus said about it in words that separate the cases. That is what
these are.

```sh
hearth cec diagnose            # the layers, cable up, stopping at the first that is not working
hearth cec list                # every command (⚠ = changes the TV)
hearth cec tv-power-status     # one read-only question
hearth cec tv-standby --yes    # a state change; refused without --yes, and read back afterwards
hearth cec send "--to 0 --give-device-power-status"   # any plain cec-ctl flags

hearth lab                     # the same, as a window on the Pi's own desktop
hearth lab --install-launcher  # a "Hearth Lab" icon on the desktop
hearth lab --listen lan        # also reachable from another machine's browser
```

The window has a button for every command, a **Diagnose** button, a raw box, a
live bus monitor, a microphone level meter with playback, a speaker test, and a
"Hearth's view" button that runs Hearth's own transport so its answer can be set
beside the raw bus. Each result shows the command line, the raw output, and a
verdict:

| Verdict | What it means | Usually |
|---|---|---|
| `reply` | the target answered | — |
| `sent` | the bus acknowledged; nothing says it was acted on | a key press, a standby — read it back |
| `no-reply` | acknowledged, and silent | the TV ignores that question |
| `not-acknowledged` | nobody is listening at that address | TV off, CEC disabled in its settings, or a cable without the CEC pin |
| `feature-abort` | "I do not support that" | a TV asked for its audio status |
| `unconfigured` | this adapter has no logical address | a reboot — see below |
| `error` | `cec-ctl` itself failed | not installed, no permission, a flag it does not know |

A command that changes the TV and has a state to read back (standby, wake, the
power keys) ends with the read-back: `verified` only if the TV itself then
reported the state, and "accepted the message and did not do it" if it did not.
Volume and navigation keys have no read-back and no acknowledgement of effect;
those are `sent`, and the screen is the only witness.

It serves on `127.0.0.1` only, behind a random token printed at start-up, and
refuses a request whose `Host` is not the loopback. It controls a television; it
is not a page for a neighbour. `--listen lan` removes the first guard and keeps
the token.

### What it found on the first day (2026-10-14, Pi 3B beside a Titan OS set)

- **A rebooted Pi has an unconfigured CEC adapter.** `Logical Address Mask:
  0x0000`, and every transmit prints `Adapter is unconfigured, please configure
  it first.` — **and `cec-ctl` exits 0.** The I/O walk-through script, which did
  not claim an address, reported "TV answers on CEC: FAILED" and the TV looked
  dead; it was fine, and answered the moment `cec-ctl --playback` ran. Hearth's
  own transport claims one on its first transmit; a hand-written script has to.
  `hearth cec diagnose` names this case, and the lab claims an address before it
  transmits and shows that it did.
- **Standby and wake over CEC work on this TV, with read-back** (2026-10-12): the
  Titan OS set reported `standby` about a second after `<Standby>` and `on` about a
  second after `<Image View On>`. That is the question 2026-10-05's report left
  open. It is a fact about the bus, read from outside, with nothing installed on
  the set.
- **The TV aborts `<Give Audio Status>`** — only audio systems answer it — so
  there is no way to read the TV's volume back over CEC, and a volume key is
  `sent`, not `verified`.
- **`cec-ctl --monitor` needs root**, even to listen. The lab tries `sudo -n` once
  and otherwise prints the command to run in a terminal.
- **On the Pi's Wayland desktop Chromium must be told `--ozone-platform=wayland`.**
  It defaults to X11 and exits with `Missing X server or $DISPLAY`;
  `--ozone-platform-hint=auto` did not help.
- **Hearth cannot yet turn the TV on or off by voice.** The agent treats the Pi as
  the television and uses CEC only for devices *past* it, so "turn off the tv"
  gets "I can set volume, mute, switch input, or open an app" even though the bus
  has just been shown to do it. The lab shows the gap from both sides; closing it
  means treating the TV as a CEC target when the box is a playback device beside it.
