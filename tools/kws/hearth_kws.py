#!/usr/bin/env python3
"""
A wake-word detector for Hearth: raw audio in, one JSON line per detection out.

    arecord -D default -f S16_LE -r 16000 -c 1 -t raw | python3 hearth_kws.py --model-dir <dir> --keyword hearth

Why this exists. The attention word used to be a filter on a *transcript*: every window with any sound in it went
to a recogniser (a paid one, by default) and the word was looked for in what came back — so a television, a
conversation in the next room and a recogniser's habit of inventing "thanks for watching" each cost a request. A
wake word is meant to be detected *before* any of that, by something small that runs all the time and knows one phrase.
This is that: sherpa-onnx's keyword spotter, a ~5 MB streaming model, on the CPU, sending nothing anywhere.

Protocol (stdout, one JSON object per line, flushed):
    {"event":"ready", "keywords":[...], "model":"...", "chunk":16}      the model is loaded; audio may start
    {"event":"keyword", "keyword":"HEARTH", "atSample":123456}          a detection; atSample counts samples read so far
    {"event":"error", "message":"..."}                                  and the process exits non-zero

stdin is mono 16 kHz signed 16-bit little-endian PCM, no header. EOF ends the process cleanly.

Keywords are English words (looked up in the model's lexicon) or Chinese characters (turned into pinyin by `pypinyin`, split into
initial and toned final exactly as the model's own examples are, and checked against its token table). Several may be given;
the label that comes back is the word as written.

This file is part of the optional wake-word path. It needs `pip install sherpa-onnx numpy` (and `pypinyin` for Chinese) and a keyword-spotting model
(e.g. sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20); the Node side (`@hearthkit/adapter-linux`, `stt/kws.ts`) starts it,
and nothing in the TypeScript depends on Python being present.
"""
import argparse
import glob
import json
import os
import re
import sys
import tempfile


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(message, code=2):
    emit({"event": "error", "message": message})
    sys.exit(code)


def lexicon(model_dir):
    """`en.phone`: one English word per line, then its phones — the same table the model was trained against."""
    path = os.path.join(model_dir, "en.phone")
    table = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    table.setdefault(parts[0].upper(), parts[1:])
    return table


CJK = re.compile("[一-鿿]")


def token_table(model_dir):
    path = os.path.join(model_dir, "tokens.txt")
    with open(path, encoding="utf-8") as f:
        return {line.split()[0] for line in f if line.strip()}


def chinese_phones(text, tokens):
    """
    A Chinese keyword as the model wants it: each syllable's initial, then its final with the tone mark ('zh ōu w àng j ūn').

    The split is pypinyin's, and it is the same one the model's own examples use ('文森特卡索' is 'w én s ēn t è k ǎ s uǒ').
    Every piece is checked against the model's token table: a syllable the model has no token for is an error that names it,
    not a keyword that quietly can never fire.
    """
    try:
        from pypinyin import Style, pinyin
    except ImportError:
        fail("Chinese keywords need pypinyin (pip install pypinyin)")
    chars = [c for c in text if not c.isspace()]
    if not chars or not all(CJK.match(c) for c in chars):
        fail("a Chinese keyword must be Chinese characters only (got %r)" % text)
    inits = pinyin("".join(chars), style=Style.INITIALS, strict=False)
    finals = pinyin("".join(chars), style=Style.FINALS_TONE, strict=False)
    phones = []
    for ch, ini, fin in zip(chars, inits, finals):
        for piece in (ini[0], fin[0]):
            if not piece:
                continue                                  # a syllable with no initial ("er")
            if piece not in tokens:
                fail("the model has no token %r (from %r in %r)" % (piece, ch, text))
            phones.append(piece)
    return phones


def keyword_lines(words, model_dir):
    """`HH AA1 R TH @HEARTH` or `l ú h uǒ j īng l íng @爐火精靈` for each word: its phones, then the label that comes back."""
    table = lexicon(model_dir)
    tokens = token_table(model_dir)
    lines = []
    for word in words:
        w = word.strip()
        if not w:
            continue
        if CJK.search(w):
            lines.append("%s @%s" % (" ".join(chinese_phones(w, tokens)), w.replace(" ", "")))
            continue
        # A phrase is its words' phones one after another; a single unknown word is an error, never a guess.
        phones = []
        for part in w.upper().split():
            if part not in table:
                fail("no pronunciation for %r in %s (the keyword must be a word the model's lexicon knows)"
                     % (part, os.path.join(model_dir, "en.phone")))
            phones += table[part]
        lines.append("%s @%s" % (" ".join(phones), w.upper().replace(" ", "_")))
    return lines


def pick(model_dir, stem, chunk, int8):
    pattern = os.path.join(model_dir, "%s-epoch-*-chunk-%s-left-*%s.onnx" % (stem, chunk, ".int8" if int8 else ""))
    found = sorted(p for p in glob.glob(pattern) if int8 or ".int8." not in p)
    if not found:
        fail("no %s model matching %s" % (stem, pattern))
    return found[0]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--keyword", action="append", default=[], help="an English word or phrase, or Chinese characters (needs pypinyin); repeatable")
    ap.add_argument("--keywords-file", help="a ready-made keywords file (phones/pinyin and @labels); overrides --keyword")
    ap.add_argument("--threshold", type=float, default=0.25, help="detection threshold: lower fires more easily")
    ap.add_argument("--score", type=float, default=1.0, help="boosting score for the keywords")
    ap.add_argument("--chunk", default="16", help="the model's chunk size: 16 or 8 (8 answers sooner, costs more CPU)")
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--fp32", action="store_true", help="use the full-precision encoder instead of int8")
    args = ap.parse_args()

    try:
        import numpy as np
        import sherpa_onnx
    except ImportError as err:
        fail("missing Python package: %s (pip install sherpa-onnx numpy)" % err)

    if not os.path.isdir(args.model_dir):
        fail("model directory not found: %s" % args.model_dir)
    keywords_file = args.keywords_file
    labels = []
    if not keywords_file:
        if not args.keyword:
            fail("give at least one --keyword (or --keywords-file)")
        lines = keyword_lines(args.keyword, args.model_dir)
        handle = tempfile.NamedTemporaryFile("w", suffix=".keywords.txt", delete=False, encoding="utf-8")
        handle.write("\n".join(lines) + "\n")
        handle.close()
        keywords_file = handle.name
        labels = [(w.replace(" ", "") if CJK.search(w) else w.upper().replace(" ", "_")) for w in args.keyword if w.strip()]
    else:
        with open(keywords_file, encoding="utf-8") as f:
            labels = [line.rsplit("@", 1)[-1].strip() for line in f if "@" in line]

    try:
        spotter = sherpa_onnx.KeywordSpotter(
            tokens=os.path.join(args.model_dir, "tokens.txt"),
            encoder=pick(args.model_dir, "encoder", args.chunk, not args.fp32),
            decoder=pick(args.model_dir, "decoder", args.chunk, False),
            joiner=pick(args.model_dir, "joiner", args.chunk, not args.fp32),
            keywords_file=keywords_file,
            num_threads=args.threads,
            keywords_score=args.score,
            keywords_threshold=args.threshold,
            provider="cpu",
        )
    except Exception as err:  # the library raises plain RuntimeError for a bad file
        fail("could not load the keyword model: %s" % err, 3)

    stream = spotter.create_stream()
    emit({"event": "ready", "keywords": labels, "model": os.path.basename(args.model_dir.rstrip("/")), "chunk": args.chunk,
          "threshold": args.threshold, "score": args.score})

    seen = 0
    stdin = sys.stdin.buffer
    while True:
        data = stdin.read(3200)                      # 100 ms; blocks until that much arrives or the pipe closes
        if not data:
            break
        data = data[: len(data) // 2 * 2]
        samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        stream.accept_waveform(16000, samples)
        seen += len(samples)
        while spotter.is_ready(stream):
            spotter.decode_stream(stream)
            hit = spotter.get_result(stream)
            if hit:
                emit({"event": "keyword", "keyword": hit, "atSample": seen})
                spotter.reset_stream(stream)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass
