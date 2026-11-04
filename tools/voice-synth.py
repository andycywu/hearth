#!/usr/bin/env python3
"""Speak the commands in a manifest with a neural voice on this box, as 16 kHz mono WAVs for tools/voice-replay.mjs.

    ~/kws/venv/bin/python tools/voice-synth.py                      bench/voice/commands.json -> ~/hearth-voice/commands-synth
    ~/kws/venv/bin/python tools/voice-synth.py --only zh-quieter --zh kokoro:3 --en amy

A synthetic voice is not a person. What a replay of these clips verifies is the path after the microphone for *this*
voice — repeatable, with nobody in the room — and nothing about how a person is heard. espeak-ng is no use here (the
small bilingual recogniser turned "hearth, turn off the tv" into "经历"); the neural voices below are what sherpa-onnx
already runs for the wake-word work, offline. Keep these clips apart from recordings of a person, and say which was used.

Models are looked for under $HEARTH_TTS_MODELS (default ~/tts-spike):
  kokoro-int8-multi-lang-v1_1        Chinese and English, mixed in one sentence ("切到 HDMI 3")
  vits-piper-en_US-amy-low-int8      English
  vits-piper-zh_CN-xiao_ya-medium-int8  Chinese only
"""
import argparse, json, os, re, sys, time, wave

import numpy as np
import sherpa_onnx

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
MODELS = os.path.expanduser(os.environ.get("HEARTH_TTS_MODELS", "~/tts-spike"))
RATE = 16000


def kokoro():
    d = os.path.join(MODELS, "kokoro-int8-multi-lang-v1_1")
    return sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=os.path.join(d, "model.int8.onnx"), voices=os.path.join(d, "voices.bin"),
                tokens=os.path.join(d, "tokens.txt"), data_dir=os.path.join(d, "espeak-ng-data"),
                dict_dir=os.path.join(d, "dict"),
                lexicon=",".join(os.path.join(d, f) for f in ("lexicon-us-en.txt", "lexicon-zh.txt"))),
            num_threads=2, provider="cpu"),
        rule_fsts=",".join(os.path.join(d, f) for f in ("date-zh.fst", "number-zh.fst", "phone-zh.fst"))))


def amy():
    d = os.path.join(MODELS, "vits-piper-en_US-amy-low-int8")
    return sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model=os.path.join(d, "en_US-amy-low.onnx"), tokens=os.path.join(d, "tokens.txt"),
            data_dir=os.path.join(d, "espeak-ng-data")),
        num_threads=2, provider="cpu")))


def xiaoya():
    d = os.path.join(MODELS, "vits-piper-zh_CN-xiao_ya-medium-int8")
    return sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=os.path.join(d, "zh_CN-xiao_ya-medium.onnx"), tokens=os.path.join(d, "tokens.txt"),
                lexicon=os.path.join(d, "lexicon.txt")),
            num_threads=2, provider="cpu"),
        rule_fsts=",".join(os.path.join(d, f) for f in ("date.fst", "phone.fst", "number.fst"))))


ENGINES = {"kokoro": kokoro, "amy": amy, "xiaoya": xiaoya}


def save(path, samples, sr):
    x = np.asarray(samples, dtype=np.float32)
    if sr != RATE:
        x = np.interp(np.linspace(0, len(x) - 1, int(len(x) * RATE / sr)), np.arange(len(x)), x)
    # Half a second of quiet before and a second after: a person does not start speaking on the first sample, and the
    # voice-activity gate and the wake detector both need some room to tell speech from the start of the stream.
    x = np.concatenate([np.zeros(RATE // 2, np.float32), x, np.zeros(RATE, np.float32)])
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    tmp = path + ".part"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(pcm.tobytes())
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("manifest", nargs="?", default=os.path.join(ROOT, "bench", "voice", "commands.json"))
    ap.add_argument("--dir", default="~/hearth-voice/commands-synth")
    ap.add_argument("--only", help="comma-separated ids")
    ap.add_argument("--zh", default="kokoro:3", help="engine[:speaker] for sentences with Chinese in them (default kokoro:3)")
    ap.add_argument("--en", default="amy", help="engine[:speaker] for the rest (default amy)")
    ap.add_argument("--redo", action="store_true", help="speak again over clips that already exist")
    a = ap.parse_args()

    out = os.path.expanduser(a.dir)
    os.makedirs(out, exist_ok=True)
    items = json.load(open(a.manifest, encoding="utf-8"))["items"]
    if a.only:
        items = [i for i in items if i["id"] in a.only.split(",")]
    loaded = {}

    def voice(spec):
        name, _, sid = spec.partition(":")
        if name not in ENGINES:
            sys.exit("unknown engine %r (have: %s)" % (name, ", ".join(ENGINES)))
        if name not in loaded:
            loaded[name] = ENGINES[name]()
        return loaded[name], int(sid or 0), spec

    for item in items:
        path = os.path.join(out, item["id"] + ".wav")
        if os.path.exists(path) and not a.redo:
            print("- %s: already there (--redo to replace)" % item["id"], flush=True)
            continue
        tts, sid, spec = voice(a.zh if re.search(r"[一-鿿]", item["say"]) else a.en)
        t = time.time()
        audio = tts.generate(item["say"], sid=sid, speed=1.0)
        save(path, audio.samples, audio.sample_rate)
        print("- %-16s %-9s %.1fs of speech in %.0fs  %s" % (
            item["id"], spec, len(audio.samples) / audio.sample_rate, time.time() - t, item["say"]), flush=True)


if __name__ == "__main__":
    main()
