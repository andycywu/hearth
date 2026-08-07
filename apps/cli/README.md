# tv-agent — the TV agent, in a terminal

For a Linux device that *is* the TV: a set-top box, a Pi, an embedded panel —
somewhere with a shell but no browser worth running an agent UI in.

It is the same agent: same loop, same tools, same adapters, same confirmation
gate as the television builds. Only the front end differs, and that is only
possible because `core` never touches a DOM.

```bash
pnpm build
node apps/cli/dist/main.js "set volume to 30"
```

## Using it

```bash
tv-agent "set volume to 30" "make it louder"   # one-shot, in order
tv-agent                                       # interactive, one command a line
tv-agent --platform linux "mute"               # drive this Linux box
echo "what's the volume?" | tv-agent --quiet   # stdout is the answer alone
```

Replies go to **stdout**, the tool trace to **stderr**, so a pipe gets the
answer and nothing else. `--json` prints one object per turn for scripting.

The session keeps its context, so `"set volume to 30"` then `"make it louder"`
means what it looks like — that is `ConversationContext`, the same one the TV
builds use.

`--help` for the rest.

## The model

With no `--llm` the built-in offline brain answers. It understands a handful of
commands, needs no network and no key, and is what the tests run against.

For a real model, point it anywhere OpenAI-compatible:

```bash
TV_AGENT_LLM=http://127.0.0.1:11434/v1 TV_AGENT_MODEL=llama3.2 tv-agent
```

**The API key comes from `TV_AGENT_API_KEY` only.** `--key` is refused, on
purpose: `ps` shows every process's arguments to every user on the machine, so a
key on the command line is a key you have shared. Same reasoning that took it
out of the TV's launch URL. See
[`docs/on-device-inference.md`](../../docs/on-device-inference.md).

## Platforms

| `--platform` | What it drives |
| --- | --- |
| `mock` *(default)* | An in-memory TV. Nothing real changes — safe to experiment with |
| `linux` | This machine, via `@tv-ai-agent/adapter-linux` |

The default is `mock` deliberately: a stray run should not be able to mute
someone's television.

## What the Linux platform can and can't do

| | |
| --- | --- |
| Volume, mute | PipeWire (`wpctl`), PulseAudio (`pactl`) or ALSA (`amixer`), whichever the box has |
| Apps | `.desktop` entries from the XDG directories — the same list a launcher shows |
| Network | From the kernel's interface list; no ping needed |
| Storage | One JSON file under `$XDG_CONFIG_HOME/tv-agent/` |
| Input switching | **Unsupported** — a Linux box has no tuner to switch to |
| Key injection | **Unsupported** — needs `xdotool`/`ydotool` and permissions that vary per image |

The last two report `TvUnsupportedError`, so the agent says "this TV can't do
that" rather than something that looks worth retrying.

## Verification status

CI runs [`tools/verify-linux.mjs`](../../tools/verify-linux.mjs) on Ubuntu on
every push — no fakes, real commands — across four legs:

| Leg | What it proves |
| --- | --- |
| `pulseaudio` | Real `pactl`: volume set/read round-trips, mute round-trips |
| `pipewire` | Real `wpctl` under a real WirePlumber session |
| `alsa-no-card` | `amixer` installed but no card must come out as *no backend*, not as broken audio |
| `none` | Nothing installed → the capability reports unsupported and the agent says so |

Also on every push: the CLI setting the volume and the platform's own tool
reading back the change.

ALSA with a real card can't be done on a hosted runner — the kernel is the Azure
cloud flavour and ships no sound modules, so `snd-dummy` won't load. That leg was
covered separately, by hand, on an Ubuntu 26.04 VM with an emulated AC'97 card
(`Intel 82801AA-ICH`): the adapter picked the `alsa` backend, round-tripped
volume and mute through real `amixer`, and the CLI's changes were confirmed with
`amixer` itself rather than by asking our own code.

That run is also where the quantisation question got a real answer. The card has
**32 steps**, so asking for 30 reads back 29 — which is why the check allows ±5
rather than demanding the exact number. A test written to expect 30 would have
passed everywhere it was written and failed on the first real device.

It also turned up a defect no fake would have: on that machine, once a GNOME
desktop session was also managing the sink, `wpctl set-volume` and
`wpctl set-mute` sometimes had **no effect at all** while exiting 0 and printing
nothing. Asking for 60% left the sink at 10% for two full seconds — not slow,
not a stale read, simply lost. Retrying doesn't help; the writes that fail keep
failing.

The adapter can't make the write land, but it no longer claims it did: every
`setVolume`/`setMute` reads back and throws if the change didn't take. The tool
layer classifies that as `failed`, so the viewer is told "that didn't work"
instead of "Done." A contended sink is normal on a desktop and shouldn't happen
on a TV image, but the honest reporting is worth having either way.

If you have a box, run the same script:

```bash
node tools/verify-linux.mjs
```
