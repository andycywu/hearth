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
English. **That has not been tried on a Pi 3B** and whether it can speak a reply in a
bearable time on a Cortex-A53 is the thing to measure before promising it. `TtsChoice`
(a voice name, a speed, a pitch) is the interface it would sit behind; nothing above
it would change.

## Where it is

- `apps/cli/src/lab-avatars.ts` — the faces and their expressions (SVG and CSS in
  strings; the lab page has no build step).
- `apps/cli/src/lab.ts`, `lab-page.ts` — the endpoints (`/api/settings`,
  `/api/voices`, `/api/ring-stream`) and the tabs.
- `packages/adapter-linux/src/tts-voices.ts` — the voice list, the timbres, the
  validation and the `espeak-ng` argument list; `ring-state.ts` — the state file.
