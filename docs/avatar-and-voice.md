# Hearth's face and voice

Two things a person can change about Hearth, both from the **Avatar** and
**Voice** tabs of `hearth lab`.

## The face

Six faces, drawn in SVG (no assets, nothing fetched, scales to a television):
**orb**, **robot**, **cat**, **owl**, **fox**, **ghost**. Pick one and it is saved
as `avatar` in `~/.config/hearth/config.json`; it is the small face in the lab's
header and the large one on the Avatar tab.

It has an expression for every state the status ring can be in, and wears the
ring's colours for them — the face and the ring are two views of one fact, and a
person who has learned that green means done should not learn it again for a fox.
Hearing it opens its eyes wide and its halo breathes blue; thinking it looks up and
to the side with three dots; speaking its mouth moves; done it smiles with a green
halo; sent-but-unconfirmed it is amber and uncertain; **cannot** is violet; failed
is red and sad; and when the microphone is lost it is dizzy and its halo blinks
red. Asleep, it has nothing to do.

**It follows the real Hearth.** Each state change the ring makes is also written to
a small file on the runtime tmpfs (`$XDG_RUNTIME_DIR/hearth-ring-state.json`, so an
animation never wears the SD card), and the lab reads it, so the face in the window
is hearing when the box is hearing — from whichever Hearth process owns the ring,
the voice app or a CEC command. A state left behind by a process that has since
died, or one older than six hours, is not believed. The "follow" box can be turned
off to try the expressions by hand, and an action taken in the lab itself (a CEC
command, the microphone, the speaker) moves the face directly, so a box with no
ring still has a face that works.

This needs the ring to be on (`leds`); without one the face is awake while the lab
is open and moves for what the lab itself does, and nothing more.

`?tab=avatar&face=fox&state=thinking` on the lab's address opens a tab and pins a
face and an expression without saving anything — for a link, a screenshot or a demo.

## The voice

espeak-ng, with what a Pi has installed and nothing else: **141 languages and
accents, each with 16 timbres** (seven male, five female, a croak, a whisper, a
Klatt synthesiser, and as-it-comes), a speed from 80 to 450 words a minute and a
pitch from 0 to 99. That is two thousand combinations, and all of them are plainly
a machine. There is a filter box for the languages, a sample sentence in the
language you pick, **Speak**, and **Surprise me**.

**Use this voice for Hearth** saves `ttsVoice`, `ttsSpeed` and `ttsPitch` to the
config, which the voice app reads when it starts (`HEARTH_TTS_VOICE`,
`HEARTH_TTS_SPEED`, `HEARTH_TTS_PITCH` set them from the environment, which wins).
**Back to the default** removes them. A saved choice that does not validate is
reported and ignored: a typo in a config file should not leave the box mute.

A voice name goes to `espeak-ng` as `-v`, so it is checked first: letters, digits and
hyphens and at most one `+variant`, nothing else — and the text to speak always goes
after `--`, so a sentence that begins `--stdout` is a sentence.

### What this is not: a neural voice

These voices do not sound like a person, and espeak-ng will not get there. The way to
a voice worth choosing between is a neural one, and the runtime already on the Pi
for recognition (sherpa-onnx's release) includes an offline text-to-speech program
that runs VITS and Kokoro models, some with dozens of speakers in Mandarin and
English. It was tried on the living-room Pi 3B (2026-10-15, sherpa-onnx v1.13.8,
4 threads, `get_throttled` 0x0 before) and **it is too slow to speak a reply there**:

| Model | Size | A short sentence | A longer one | Memory | Real-time factor |
|---|---|---|---|---|---|
| Piper en_US *amy-low*, int8 | 37 MB | 4.1 s to make 2.4 s of speech | 7.9 s for 4.7 s | ~100 MB | 1.7 |
| Piper zh_CN *xiao_ya-medium*, int8 | 20 MB | 7.2 s for 2.6 s | 17.6 s for 6.1 s | ~120–150 MB | 2.7–2.9 |
| Kokoro multi-lang v1.1, int8 (many speakers) | 207 MB | **31.5 s** for 2.1 s | 59.6 s for 4.0 s | ~330 MB | 14–15 |
| Melo zh+en, int8 | 183 MB | — | — | — | the int8 file would not load (`Protobuf parsing failed`); not retried with the fp32 one |

A real-time factor above 1 means it takes longer to make the speech than the speech
lasts, and a spoken reply has to start within a second or two to feel like an answer.
The best of them, the small English Piper voice, needs about four seconds for
"I turned the volume down to thirty" — and each run here also paid ~20 s to load the
model, which a resident server would pay once. Two caveats against the numbers: the
Kokoro and Chinese runs came later in the sequence while the SoC climbed from 56 °C
to 80.6 °C and ended with the clock capped (`get_throttled` 0x20002 — thermal, not
under-voltage), so they are slower than a cooled board would be, but not by
anything like the factor of ten that separates Kokoro from usable.

So on a Pi 3B, espeak-ng is the voice, and these are the ways to something better:
a TTS server on another machine on the LAN (the same arrangement the recogniser's
`--asr <url>` already uses, and the one OpenAI-compatible `/audio/speech` servers
speak, which would also let one choose among their many voices), a Pi 4/5 where the
same models run several times faster, or a handful of fixed replies synthesised once
and cached. `TtsChoice` (a voice name, a speed, a pitch) is the interface any of them
would sit behind; nothing above it would change.

## Where it is

- `apps/cli/src/lab-avatars.ts` — the faces and their expressions (SVG and CSS in
  strings; the lab page has no build step).
- `apps/cli/src/lab.ts`, `lab-page.ts` — the endpoints (`/api/settings`,
  `/api/voices`, `/api/ring-stream`) and the tabs.
- `packages/adapter-linux/src/tts-voices.ts` — the voice list, the timbres, the
  validation and the `espeak-ng` argument list; `ring-state.ts` — the state file.
