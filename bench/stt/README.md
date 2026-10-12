# Speech-to-text benchmark data

This directory holds the *description* of a benchmark, not the audio. There are
no recordings in the repository, and none were generated: a synthetic voice is
not a person in a living room, and the numbers it produces would be about the
synthesiser. Recordings are also somebody's voice, which is a reason not to
commit them to a public repository.

`tv-commands.json` lists the commands to record and what each should come back
as. `hearth stt bench` reads it, runs whichever clips exist, and reports the
rest as `missing_audio` — so the set can be filled in a few clips at a time.

## Making the recordings

Each clip is 16 kHz, mono, 16-bit PCM WAV, named as the manifest says, in
`recordings/` next to the manifest (git-ignored). On the box that will run the
recogniser, so the microphone is the one being measured:

```sh
mkdir -p bench/stt/recordings
arecord -D default -f S16_LE -r 16000 -c 1 -d 4 bench/stt/recordings/zh-001.wav
# say "打開電視", then the next id
```

Anything in another format is refused with an error that says what it found —
the benchmark does not resample, because a benchmark that converted its input
would be measuring the converter.

Say what the manifest says, the way you would say it to a television. Record
each command more than once, in different places in the room and with the
television on and off if that is the situation Hearth will be used in; give the
clips distinct ids and keep the same `expected`. One person on one afternoon is
a smoke test, not a result.

## The manifest

```json
{
  "name": "tv-commands",
  "items": [
    { "id": "zh-001", "audio": "recordings/zh-001.wav", "expected": "打開電視",
      "language": "zh", "tags": ["power"] }
  ]
}
```

`id` (unique), `audio` (relative to the manifest) and `expected` are required;
`language` (`zh`, `en`, `mixed`) and `tags` are carried into the report so it
can be cut by them. `expected` is compared after lowercasing and dropping spaces
and punctuation, so `Netflix` and `NETFLIX` are the same. Character error rate
over Chinese is per character; over English it is per letter, which is generous
to near-misses — read the `actual` column too.

## Running it

```sh
hearth stt bench bench/stt/tv-commands.json --out bench/stt/results/sherpa-1
hearth stt bench bench/stt/tv-commands.json --realtime --out bench/stt/results/sherpa-1r
```

The same command with another `HEARTH_STT_BACKEND` is how backends are compared:
same clips, same arithmetic. Only `sherpa` exists today. See
[`docs/edge-voice.md`](../../docs/edge-voice.md) for what the columns mean, why
there are two modes, and why a run on a throttled Pi is not a result.
