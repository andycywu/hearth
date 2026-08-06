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

**Still unverified:** ALSA with a real card. A GitHub runner's kernel is the
Azure cloud flavour and ships no sound modules, so `snd-dummy` can't be loaded —
`amixer`'s integration is covered by parser tests against recorded output and by
the no-card case, but never against a working mixer. Also unverified: real
hardware quantisation (a device's actual volume steps and dB curve).

If you have a box, run the same script:

```bash
node tools/verify-linux.mjs
```
