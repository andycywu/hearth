# Edge voice: microphone to text, on the device

Hearth's voice path used to end at a cloud endpoint: record five seconds with
`arecord`, send the WAV to a whisper API, get words back. That works, and it
sends every sound in the living room to someone else's server. This is the other
path — speech recognised on the box, with no network — built so the recogniser
can be swapped without touching anything around it.

**Status: Phase 1A, measured on a Raspberry Pi 3B on clean power, not yet
exercised with a person speaking to it.** What has run, and what it showed, is in
[What has been measured](#what-has-been-measured). Everything not listed there
is unverified.

## The pipeline

```
AudioInput → AudioPreprocessor → WakeWordDetector → VoiceActivityDetector
           → SpeechToTextEngine → Transcript → IntentRouter
```

Each stage is an interface in `packages/edge-voice` (`src/types.ts`) and none of
them names an engine. `createPipeline` wires them and does the parts that are
the same whatever is behind them: it keeps the speech-to-text engine idle until
a wake word fires, opens one recognition session per utterance, stamps each
`Transcript` with its position in the audio stream, and logs the latency and
memory of every utterance.

| Stage | Interface | What exists today |
|---|---|---|
| Audio in | `AudioInput` | `arecord` streaming raw PCM (`adapter-linux/src/stt/arecord-input.ts`); a scripted fake for tests |
| Preprocessing (AEC / NS / AGC) | `AudioPreprocessor` | the interface only. `HEARTH_AUDIO_PREPROCESSING_ENABLED=true` is accepted and *says it does nothing* |
| Wake word | `WakeWordDetector` | the interface only. `HEARTH_WAKE_WORD_ENABLED=true` likewise. The CLI's existing text attention word (`--wake`) is unchanged and lives above this |
| VAD | `VoiceActivityDetector` | an energy gate (`createEnergyVad`) — see the caveat below |
| Speech to text | `SpeechToTextEngine` | sherpa-onnx, over its websocket server. `whisper` and `vosk` are reserved names, not built |
| Transcript | `Transcript` | `{ text, language, isFinal, confidence, startTimeMs, endTimeMs, backend }` |
| Intent routing | `IntentRouter`, `AiTaskClient` | the interfaces only. Nothing routes yet |

Three things in the contract are deliberate. `confidence` is `null` unless the
engine reports something meaningful — sherpa's streaming transducer does not, so
it is `null`, and nothing here invents a number. `language` is `null` for the
same reason: a bilingual model does not say which language it heard. And a
non-streaming engine with no VAD is refused at construction, because nothing
would tell it where an utterance ends.

### Where Jev and ModelPilot attach

Hearth does not choose a model. `AiTaskClient.solve(task)` returns `solved` or
`escalate`, and what is behind it is not Hearth's business. Nothing implements
it yet. The one fact that shapes the implementation: Jev (TypeSafe AI's model,
`POST https://api.typesafe.ai/v1/systemone`) answers *typed judgement
questions* — a choice among options, a yes/no, a score — each with a
probability or confidence. It does not write open-ended answers. So the natural
`IntentRouter` is a `choice` question ("is this a device command, and which?"),
and `escalate` is a confidence below a threshold that has to be *calibrated on
real transcripts*, not chosen. Jev is a cloud call: the words leave the box at
that point, so the edge-and-offline claim covers recognition, not routing.

### The VAD caveat

`createEnergyVad` listens for loudness and nothing else, because a neural VAD
(silero) needs an ONNX runtime inside Node and this repo carries no runtime
dependencies. It will open a recognition session for a television in the next
room as readily as for a person. The recogniser then decides there was nothing
to say, which costs CPU and not correctness. The default threshold, rms 0.01,
is above the quiet-room floor measured on the living-room Pi (0.003–0.0085) and
is a measurement of one room, not a calibration. The interface is the seam for
a better detector.

## Configuration

Read once, in `packages/edge-voice/src/config.ts`; nothing else reads the
environment. Environment beats the default; a value that does not parse is a
warning and falls back.

| Variable | Default | |
|---|---|---|
| `HEARTH_AUDIO_DEVICE` | `default` | ALSA capture device |
| `HEARTH_SAMPLE_RATE` | `16000` | the model's rate; there is no resampler |
| `HEARTH_CHANNELS` | `1` | |
| `HEARTH_AUDIO_PREPROCESSING_ENABLED` | `false` | no backend yet |
| `HEARTH_WAKE_WORD_ENABLED` / `HEARTH_WAKE_WORD` | `false` / `hearth` | no detector yet |
| `HEARTH_VAD_ENABLED` | `true` | off feeds the raw stream to a streaming engine |
| `HEARTH_STT_BACKEND` | `sherpa` | |
| `HEARTH_STT_MODEL_PATH` | — | unpacked sherpa-onnx *transducer* model directory |
| `HEARTH_STT_RUNTIME_PATH` | — | unpacked sherpa-onnx release (has `bin/` and `lib/`) |
| `HEARTH_STT_SERVER_URL` | — | an already-running server; overrides the two above |
| `HEARTH_STT_LANGUAGE` | — | recorded, not yet used by the sherpa backend |
| `HEARTH_LOG_LEVEL` | `info` | `debug` adds partial transcripts |

The names carry the `HEARTH_` prefix the rest of the CLI uses, not the bare
`STT_BACKEND` of the design note.

## Setting it up on a Raspberry Pi 3B

You need a 64-bit OS (the aarch64 build), Node 26, `arecord`, and about 500 MB
of disk for the model archive while unpacking.

**Power first.** Check `vcgencmd get_throttled`. Anything other than `0x0` and
the numbers below mean nothing — see [Throttling](#throttling-and-undervoltage).

**Install sherpa-onnx.** The prebuilt aarch64 release carries every tool this
needs, including `sherpa-onnx-online-websocket-server`; nothing is compiled:

```sh
mkdir -p ~/stt && cd ~/stt
B=https://github.com/k2-fsa/sherpa-onnx/releases/download
curl -fsSLO $B/v1.13.8/sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2
tar xjf sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2     # → ~/stt/sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu/
```

**Download a model.** The one measured here is the small bilingual (Mandarin +
English) streaming zipformer; the archive is 458 MB and contains both fp32 and
int8 files, of which Hearth picks int8:

```sh
curl -fsSLO $B/asr-models/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2
tar xjf sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2
```

Other models from the same release page work if they are streaming transducers
(`encoder*`, `decoder*`, `joiner*`, `tokens.txt`). A CTC or paraformer model is
a different server flag set and is not wired.

**Choose the microphone.** `arecord -l` lists cards. `default` follows
`/etc/asound.conf`, which a ReSpeaker install writes; to pin one,
`HEARTH_AUDIO_DEVICE=plughw:2,0` (card 2, device 0). The recogniser wants mono
16 kHz and `arecord` is asked for exactly that; which channel of a four-channel
ReSpeaker array the conversion keeps has not been checked.

**Run it.**

```sh
export HEARTH_STT_RUNTIME_PATH=~/stt/sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu
export HEARTH_STT_MODEL_PATH=~/stt/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16
hearth stt                     # transcripts on stdout, JSON metrics on stderr
hearth stt --json              # each final as a Transcript object
HEARTH_LOG_LEVEL=debug hearth stt     # plus partials
```

Hearth starts the server itself and stops it on exit. Starting takes **about
16–20 seconds** on a Pi 3B while the model loads; the first
`pipeline_started` line is the signal it is listening. The server stays up for
the life of the process — it is not restarted per utterance, which would make
every sentence wait for the model.

## Measuring: benchmark mode

```sh
hearth stt bench bench/stt/tv-commands.json --out /tmp/run1            # fast
hearth stt bench bench/stt/tv-commands.json --realtime --out /tmp/run1r
```

The same engine, the same clips, a JSON report on stdout and, with `--out`,
`run1.json` and `run1.csv`. Each result has the expected and actual text, a
character error rate (case, spaces and punctuation are ignored), the audio and
decode time, the real-time factor, the latency from the end of the audio to the
final result, and the memory of Hearth and of the engine's own process.

The two modes answer different questions and the report says which it was.
**Fast** pushes audio as quickly as the engine takes it, so `rtf` is
throughput. **Realtime** paces the audio to its own clock, as a microphone
would, and is the only mode where `finalLatencyMs` means "how long after the
person stopped talking". A recording that does not exist yet is `missing_audio`,
not a failure; one in the wrong format (not 16 kHz mono 16-bit PCM) is an
`error` that says so — nothing is silently resampled, because a benchmark that
converted its input would be measuring the converter. The dataset format and
the commands to record are in [`bench/stt/README.md`](../bench/stt/README.md).

## What has been measured

On the living-room Pi 3B (Cortex-A53, 905 MB, Debian 13), sherpa-onnx v1.13.8,
the small bilingual zipformer, int8, 2 threads, through Hearth's own
`hearth stt bench` over the model's four bundled human-speech clips (4.7–10 s),
five passes through one server, 2026-10-12. **`get_throttled` read `0x0` before,
after and between runs, with no under-voltage events in the boot's kernel log**;
the board reached 71 °C with no soft-limit flag. This is the first run on clean
power — the first one, on 2026-10-06, was taken while the board reported
`0x50005` and ran about twice as slow (RTF 0.79–0.94, 0.5–0.7 s to final); the
cause was the USB cable, and those numbers are superseded.

- **Memory:** the model server sits at **111 MB** resident in fast mode and
  **115 MB** in realtime mode, and **did not move across 20 utterances**
  (every item read the same value). Node itself about 74 MB. Plenty of room in
  1 GB. Twenty utterances is a smoke test for growth, not a soak.
- **Start-up:** about 16–20 s to load.
- **Throughput:** real-time factor **0.43–0.48** in fast mode — the recogniser
  decodes a clip in under half its own length, which is real headroom on this
  core. (In realtime mode `rtf` is ≈ 1 by construction; it measures the pacing,
  not the engine.)
- **Latency after the end of speech**, in realtime mode: **0.26–0.39 s**
  (p50 274 ms, p95 391 ms; one value per clip was stable to a few ms across all
  five passes). That is the server decoding its 0.8 s tail padding. The
  pipeline's VAD then adds its own hangover (600 ms by default) before it knows
  the utterance ended, so **end-to-end from the last word should be about
  0.9–1.0 s — at the edge of the 1 s goal** — the sum of two measured parts, not
  something measured end to end. Both parts have obvious knobs
  (`--end-tail-padding`, the hangover) and neither has been turned. (Fast-mode
  `finalLatencyMs` is 2–4 s and means nothing: it is the backlog of audio pushed
  faster than it can be decoded.)
- **Determinism:** the same clip gave the same text on all five passes.
- **Accuracy: not measured.** The model's own clips come back as sensible
  Mandarin and English. The benchmark's CER column is meaningless here — those
  clips have no reference transcript in the manifest. Six synthetic `espeak-ng`
  clips of TV commands (run on the throttled board) came back mostly wrong
  (`啊电`, `要`, `JOVI`) — which says a robot voice is not a person, not that the
  model is bad. There are no recordings of anyone saying a TV command, so
  nothing here is evidence about the commands this exists for.
- **Not run:** live microphone with a person speaking; a long soak; the wake
  word; preprocessing; any second backend.

## What was learned getting here

- **`is_final` does not mean the stream is over.** The server's endpointing
  sets it on a segment mid-utterance, then carries on. The first version of the
  backend treated it as the end, returned early, and would have dropped
  anything said after a pause. Only the `Done!` frame ends an utterance. It
  showed up as `finish()` taking 1 ms on real speech where a hand-written probe
  had seen the same server take 500 ms.
- **An utterance's text is its segments joined**, not the last frame, because
  each frame carries the current segment only.
- **Partials lag by one chunk.** The server answers a chunk after `push`
  returns, so a push reports what the chunks before it produced.
- **Start-up is long enough to be the design.** 16–20 s per model load is why
  the engine is a long-lived server and not a process per utterance.

## Throttling and undervoltage

A Pi that is undervolted cuts its clock to protect itself, and every inference
number taken then is slower than the hardware's. Before benchmarking:

```sh
vcgencmd get_throttled        # throttled=0x0 is what you want
vcgencmd measure_clock arm    # under load, ~1200000000 on a 3B
vcgencmd measure_temp
journalctl -k -b | grep -i voltage    # "Undervoltage detected!" lines, with times
```

`get_throttled` is a bit field: bit 0 under-voltage now, bit 1 frequency capped
now, bit 2 throttled now, bit 3 soft temperature limit now; bits 16–19 are the
same four *since boot*. `0x50005` is "under-voltage and throttled, now and
earlier". A benchmark is valid only if it ends with the same value it began
with, and that value is `0x0`.

The usual cause on a Pi 3B is the cable, not the supply: its under-voltage
threshold is 4.63 V, and a loaded board with a microphone HAT and an LED ring
draws enough to cross it on a marginal lead. A high-wattage charger on a thin
lead does not help. Short, thick, and nothing else on the USB ports while
measuring.

## Known limits on a Pi 3B

- A Cortex-A53 has no dot-product instructions, so int8 buys less than it does
  on newer cores. Expect the real-time factor to sit near 1 with a model this
  size; a larger model will not keep up.
- 1 GB is shared with whatever else runs. A desktop session costs 150–200 MB
  that the model would rather have; `multi-user.target` gets it back.
- The energy VAD cannot tell speech from a television (see above), and the
  Pi has no reference signal for the television's own audio, so echo
  cancellation can remove Hearth's own speech but not a film.
- The websocket protocol is the one observed on v1.13.8. A different release
  is not promised to behave the same.

## Troubleshooting

| Said | Means |
|---|---|
| `no speech model configured` | set `HEARTH_STT_MODEL_PATH` and `HEARTH_STT_RUNTIME_PATH`, or `HEARTH_STT_SERVER_URL` |
| `sherpa-onnx server exited (…)` followed by a message | the server's own stderr, e.g. a model file it could not open; fix the path |
| `sherpa-onnx server did not come up` | it did not accept a connection within 90 s; the model is too big for free memory (check `free -m`) or the disk is slow |
| `arecord stopped capturing from "…"` | the microphone went away or is busy (`fuser -v /dev/snd/*`); Hearth stops rather than retrying |
| `no sherpa-onnx server at ws://…` | `HEARTH_STT_SERVER_URL` points at nothing |
| `this Node has no global WebSocket` | Node older than 22; the repo requires 26 |
| every transcript is empty | the room is quiet and the energy gate never opened — or the gate is too high; watch `HEARTH_LOG_LEVEL=debug` |
| `HEARTH_STT_BACKEND=whisper: this build has only sherpa` | the name is reserved, not built |
| `… failed 3 times in a row; stopping` | the engine crashed on three utterances running; read the `stt_error` lines above it |

## Where the code is

- `packages/edge-voice` — contracts, `createPipeline`, the energy VAD, the
  config, the benchmark, WAV reading, and the fakes. No dependencies, no
  hardware; all of it is tested without a microphone.
- `packages/adapter-linux/src/stt` — the parts that need a Linux box: the
  streaming `arecord` input, the sherpa-onnx backend and the process wrapper
  both use.
- `apps/cli/src/stt.ts`, `stt-bench.ts` — `hearth stt` and `hearth stt bench`.
