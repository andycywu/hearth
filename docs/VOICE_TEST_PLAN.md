# Voice test plan — what only a person speaking can show

_Written 2026-10-19, for the Pi 3B with a ReSpeaker 4-Mic array on HDMI 3 of a Titan OS television._

Everything in this repository that listens has been exercised with **recorded files, a robot voice, or a scripted
microphone**. That finds real defects (the sherpa `Done!` handshake, the CEC adapter that is unconfigured after a
reboot) but it cannot answer the questions below, because each one depends on a human mouth, a real room, or a
transcriber's spelling of a word it has never been taught. Until these are done, **no spoken command has been
verified end to end**, and the project says so ([`STATUS.md`](STATUS.md)).

The rule of the project applies to this plan too: each row ends `verified`, `unverified` or `failed`, with the number
that was seen. A row with no number is not a result.

## Before any of it

| | Check | Why |
|---|---|---|
| a | `vcgencmd get_throttled` reads `0x0` | `0x50000` (seen 2026-10-19) means it has under-voltaged since boot. Reboot, then read it again; timings taken under throttling are the ones that were twice as slow on a bad cable |
| b | `hearth modelpilot status` → both `verified` | the conversation and planning steps need it |
| c | `hearth --platform linux setup` shows `voice: true`, a wake word, and the ring | run it from a shell that sourced `~/.config/hearth/env`, or it used to switch listening off (fixed, but check) |
| d | the remote is within reach | V6 turns the television off |
| e | decide the room: door closed, television **off** for V1–V10; on for V11–V12 | background is the variable that matters most |

Say each phrase **at the distance and volume you would use to a television**. Do not enunciate for the machine; the point
is how it copes with you.

## The tests

### V1 — the silence gate

Is `0.01` the right RMS threshold for this microphone?

```sh
hearth --voice          # stay silent for 30 seconds, then say one sentence, then stay silent for 30 more
```

- **Expect:** `🎤 (silence (rms 0.00x < 0.01))` lines while quiet, and nothing for the room. One line for the sentence.
- **Record:** the quiet RMS values (min / max) and the RMS of your speech at 1 m.
- **Fails if:** quiet reads above 0.01 (the gate is open to noise and every window is sent to the transcriber, at a price),
  or speech reads below it (the gate drops you).

### V2 — record yourself, once

```sh
bash tools/pi-record-voice.sh            # into ~/hearth-voice; it asks for three phrases
bash tools/pi-selftest.sh --tv-power
```

- **Why:** the offline model cannot read espeak-ng (2026-10-14: "hearth, turn off the tv" came back as "经历"). A
  self-test that plays a robot into the recogniser can only fail and says nothing about a person.
- **Expect:** the three recordings kept (each clearly louder than the room), then the self-test running them through the
  voice path.
- **Record:** what each recording was transcribed as.

### V3 — recognition accuracy, measured

Record the 15 commands in [`bench/stt/tv-commands.json`](../bench/stt/tv-commands.json) (English and Chinese, as the file
describes), then:

```sh
hearth stt bench bench/stt/tv-commands.json --realtime --out ~/stt-run
```

- Run it twice: **hosted** (the current config, `--asr openai`) and **on the box** (`hearth setup --asr local` with
  `HEARTH_STT_MODEL_PATH` / `HEARTH_STT_RUNTIME_PATH`, see [`edge-voice.md`](edge-voice.md)).
- **Record per backend:** word/character error rate, the commands it got wrong and what it heard, the delay from the end
  of the audio to the text, resident memory, `get_throttled` before and after.
- **Known so far:** real-time factor 0.43–0.48 and ~0.3 s to final text on files; **no number exists for a person.**

### V4 — how the wake word is spelled (do this early)

Everything after depends on it. Say **"hearth, turn it down"** ten times, then **"hearth"** alone five times, then the same
in a flat tone and a quick one.

```sh
hearth --voice          # watch the 🎤 lines
```

- **Record:** every transcription, verbatim.
- **Known:** "hearth, turn off the light" was heard as **"Hard turn off light."** and dropped. Aliases now exist
  (`hard`, `harth`, `hart`, `heart`, `hurth`, `herth`) and count only as the **first word with a command after it**; a
  line taken that way is marked `(taken as "hearth": heard "hard")`.
- **Decide from the numbers:** if more than two in ten need an alias, change the wake word (a word the transcriber can
  spell) instead of widening the list. Widening it widens what a television's dialogue can trigger.
- **Also test Chinese** if you use a Chinese wake word: `hearth setup --wake 小爐` and say it ten times.

### V5 — volume by voice

"hearth, turn it down" · "hearth, mute" · "hearth, set volume to 30" · "hearth, louder"

- **Expect:** ring dim blue (listening) → white (thinking) → green (`verified`); the sink actually moved
  (`wpctl get-volume @DEFAULT_AUDIO_SINK@`); the reply spoken.
- **Record:** speech end → first sound of the reply, in seconds, over five tries; any `unverified` outcome and why.
- Restore the volume to your normal level afterwards.

### V6 — the television, by voice

"hearth, turn off the TV" · wait · "hearth, turn on the TV" · Chinese: 「關電視」 · 「開電視」

- **Expect:** the set goes to standby and comes back, each with a read-back (`tv.power.status`), ring green.
- **Watch for:** the adapter unconfigured after a reboot (`cec-ctl` exits 0 on "Adapter is unconfigured"; `hearth cec
  diagnose` names it); a set that takes several seconds to answer a power query.
- **Record:** time from the spoken command to the screen going dark, and to it lighting.

### V7 — a question (through ModelPilot)

"hearth, what is the capital of France" · "hearth, how many days until Christmas" · one Chinese question

- **Expect:** a correct, spoken answer; the ring moving while it works.
- **Record:** speech end → first sound, over five tries. Measured on typed input it is about 5 s of model time plus
  ~1 s of speech start; a spoken question also pays recognition. **Nobody has felt this yet — say if it is too slow.**

### V8 — asking about the Pi itself

"hearth, how hot is the Pi" · "hearth, how much memory is free" · "hearth, is the power supply okay"

- **Expect:** numbers that agree with `vcgencmd measure_temp` and `/proc/meminfo`, and — if it has happened — the
  under-voltage since boot, said plainly.

### V9 — speaking while it writes (A/B)

Ask the same long question five times each way ("explain in five sentences what HDMI-CEC is"):

```sh
hearth --voice                    # whole reply, spoken at the end
hearth --voice --stream-speech    # sentence by sentence
```

- **Measured on typed input:** the first word about 1.5 s sooner; each sentence carries ~0.5 s of audio-device gap.
- **Judge by ear:** is the earlier start worth the gaps? Is espeak-ng's voice acceptable for a full paragraph? Do two sentences
  ever overlap or drop? This decides whether `--stream-speech` becomes the default.
- **Record:** your verdict per length of answer (one sentence / three / five).

### V10 — does it hear itself?

Use it normally for ten minutes with the wake word on.

- **Expect:** its own spoken replies never become a new command. (With `--no-wake` they do — the test of 2026-10-19 showed
  extra turns — which is why the wake word is not optional on a room microphone.)
- **Record:** the number of turns it started that nobody asked for.

### V11 — distance and a playing television

20 phrases each at: 1 m, 3 m, and 3 m **with the television at your normal viewing volume** (a film with dialogue).

- **Record:** how many were acted on correctly, and what the rest were heard as.
- **Watch the VAD:** speech cut off early, or the room's noise holding the gate open (the energy gate is the one measured in V1;
  `HEARTH_VAD_ENABLED=false` removes it, see [`edge-voice.md`](edge-voice.md)).
- **Not expected to be good:** there is no echo cancellation. The television's own sound is in the microphone. This test
  exists to put a number on how much that costs.

### V12 — false accepts

Television dialogue for ten minutes, and two people talking nearby, wake word on; one of them says things containing "hard"
and "heart" ("that's hard", "I love you with all my heart").

- **Expect:** no actions. An alias is accepted only as the first word with a command after it.
- **Record:** every action taken that nobody intended. **Any is a defect to report.**

### V13 — mixed language

"hearth, 把音量調小一點" · "hearth, set the volume to 三十"

- **Record:** what each was heard as, whether the command parsed, whether the reply came in the language asked.

### V14 — when something is wrong

Pull the network cable, then say a command. Then put a wrong key in the environment file temporarily (do it with `read -rs`,
never on a command line) and say one.

- **Expect:** the ring shows the error state; the reply says what is wrong; nothing is silently dropped. Reconnected, the
  next command works without a restart.

### V15 — an hour

```sh
hearth --serve                    # or the service, once V16 is done
```

- **Record:** resident memory at 0, 30 and 60 minutes (`ps -o rss= -p $(pgrep -f main.js)`), whether it is still
  listening, `get_throttled` and temperature at the end.
- **Expect:** flat memory (the edge pipeline was ~111–115 MB and flat over 20 utterances; this is the long version).

### V16 — after a reboot

```sh
hearth --platform linux setup                          # writes ~/.config/hearth/hearth.service
systemctl --user enable --now hearth && loginctl enable-linger "$USER"
sudo reboot
```

- **Expect:** after boot, with nobody logged in, "hearth, turn it down" works.
- **Not yet verified.** `setup` writes the unit; nothing has confirmed that it is installed, enabled, or survives a reboot.

## What is not on this list, and why

- **Interrupting it while it speaks** — needs echo cancellation, which is not built; the microphone is closed while it speaks.
- **A real wake-word detector** — the attention word is a transcript filter: every window is still transcribed. A detector is
  what removes that cost and cuts false accepts; it is not built.
- **Better voices** — neural TTS was measured and is too slow on a Pi 3B (RTF 1.7–14); a LAN TTS server is an option nobody
  has chosen.
- **The 15-minute stranger test** — [M1's exit condition](PRODUCT_PLAN.md): someone who is not the author, from `git clone` to
  a first command, using only the README. Not a voice test, but it needs a stranger.

## Results

Copy this table into [`platform/reports/pi3b-titanos-mt9620.md`](platform/reports/pi3b-titanos-mt9620.md) as a dated note
(reports are generated and never hand-edited except for a dated note at the end).

| Test | Date | Verdict | The number seen / what was heard |
|---|---|---|---|
| V1 silence gate | | | quiet rms: · speech rms: |
| V2 recordings | | | |
| V3 accuracy, hosted | | | error rate: · latency: |
| V3 accuracy, on the box | | | error rate: · latency: · RSS: |
| V4 wake word spelling | | | heard as: |
| V5 volume | | | speech end → sound: |
| V6 television power | | | off: · on: |
| V7 question | | | speech end → sound: |
| V8 Pi status | | | |
| V9 stream A/B | | | verdict: |
| V10 hears itself | | | unasked turns: |
| V11 distance / TV playing | | | 1 m: /20 · 3 m: /20 · 3 m + TV: /20 |
| V12 false accepts | | | |
| V13 mixed language | | | |
| V14 errors | | | |
| V15 an hour | | | RSS 0/30/60: |
| V16 after reboot | | | |
