# The status ring: what the lights mean

The ReSpeaker array's twelve LEDs are the one feedback channel on a Pi that does
not take the television's picture away. This page is what they say.

**The rule: moving means work is happening; still means nothing is.** A ring that
is dark through a minute of work looks the same as a ring that is broken — on
2026-10-14 "the lights don't change" could not be told from either — so every
stage of work has a light of its own, and the resting state is the only one that
does not move.

## The states

| State | Looks like | Means |
|---|---|---|
| *ready* | dim blue, **still** | awake and waiting. Nothing is happening |
| `loading` | a blue-green dot going round | the speech model is being read into memory (~20 s on a Pi 3B) |
| `hearing` | blue, breathing | someone is speaking |
| `recognizing` | a pale tail going round | they stopped; the words are being worked out |
| `thinking` | a white tail going round | the agent is planning |
| `acting` | a fast cyan tail | a command is on its way — a CEC message, the volume |
| `speaking` | magenta, breathing | the box is talking |
| `verified` | **green**, still | done, and read back from the device |
| `unverified` | **amber**, still | sent; nothing can confirm it |
| `unsupported` | **violet**, still | this device cannot do that |
| `failed` | **red**, still | tried, and it did not work |
| `error` | red, blinking | it cannot carry on — the microphone went away |

The four answers are held still for 2.5 seconds so they can be read, then the ring
settles to ready. An answer is never shown kinder than it is: a TV that accepted
`<Standby>` and stayed on is red, not green, and a CEC message with nothing to
read back is amber.

A normal spoken command goes: ready → *hearing* → *recognizing* → *thinking* →
*acting* → **green** (held) → ready. While the model loads at start-up it is
*loading*, then ready.

## Which commands drive it

Anything that works, when `leds` is on (`hearth setup` turns it on for a box with a
ring; `--leds` forces it): the voice agent (`hearth --voice --leds`), `hearth stt`,
`hearth cec …` (acting, then the answer's colour, then dark), and `hearth lab` (the
same for every button, with *hearing* while the microphone records and *speaking*
while the speaker plays).

## Seeing it

```sh
hearth ring demo        # every state in turn, four seconds each, with what it means; ends dark
hearth ring thinking    # one state, held until Ctrl+C
hearth ring off
```

`hearth ring demo` runs only the lights, so a ring that does nothing can be told
apart from a voice stack that is not running.

## What it costs

Twelve LEDs are a real load on a Pi 3B's supply, so the moving states run at a
middle brightness (8/31) — brighter than ready (3/31), dimmer than an answer
(10/31). Switching the LED rail on (the power gate on GPIO5) is itself enough to
make a marginal supply dip: on 2026-10-14, with a cable that otherwise read
`get_throttled = 0x0`, the first state of `hearth ring demo` produced one
"Undervoltage detected" four seconds long, and the rail then stayed up through
every animation without another. It is a measure of how little margin that supply
has, not of what the animation draws. A shorter, thicker cable or a stronger supply
removes it; until then expect one brief under-voltage flag per start-up, and read
any timing taken in that window with that in mind.

## Where it is

`packages/adapter-linux/src/leds.ts` — the states, the frames (`ringFrame` is a
pure function of the tick, so every animation is tested without a ring), and the
hold. `apps/cli/src/voice-ring.ts` maps what the speech pipeline reports to a
state; `ring-tool.ts` is `hearth ring`.
