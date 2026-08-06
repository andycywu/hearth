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

Honest about this: the CLI and the adapter's logic are covered by tests and were
run end to end, **but not on real Linux hardware** — the machine this was written
on is Windows, and the audio tools were exercised through a fake that only
answers to the exact arguments `wpctl` takes. The parsers are tested against real
recorded output from `wpctl`, `pactl` and `amixer`.

What that means in practice: the shape is right and the commands are right, and
the first run on an actual box may still turn up something. If you have one,
`tv-agent --platform linux "what's the volume?"` is the thing to try first.
