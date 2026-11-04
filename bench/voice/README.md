# Spoken commands, replayed

`commands.json` lists commands said to Hearth — each with the wake word — and what
the television should read back afterwards. The audio is not here: it is somebody's
voice, and it stays on the box that recorded it (`~/hearth-voice/commands` by default).

Record once, in the room, at the distance you would speak to the television:

```sh
node tools/voice-record.mjs                  # waits for Enter before each phrase; run it in your own terminal
```

Then replay as often as you like, with nobody in the room:

```sh
node tools/voice-replay.mjs --tv-module <path>
```

Each clip is played into Hearth as its microphone (`HEARTH_AUDIO_DEVICE=file:...`),
using the recogniser and wake detector the box is configured with. The television is
read before and after through the same module Hearth drives it with, and the result
is `verified` only when the reading shows what was asked — an answer that says "done"
over a volume that did not move is `failed`. The television is put back after every
clip, so each starts from where the first one did.

This tests everything after the air. It does not test the air: distance, the room's
noise and the television's own sound still need a person.

An expectation is any of `volume` (`"up"`, `"down"` or a number, ±2 for the
television's own scale), `mute`, `input`, `layout`, and `says` — words the answer
must contain, where `{volume}`, `{input}`, … are filled from the reading before.
