/**
 * Speaking while the answer is still being written.
 *
 * A streamed reply reaches the CLI in pieces — words, not sentences. A speech engine wants sentences: `espeak-ng`
 * is started once per utterance, and a word at a time would be a stutter. So three small things, none of which know
 * about the others:
 *
 *  - `createSentenceSplitter` turns a stream of text into sentences, as soon as a sentence is known to be over.
 *  - `createSpeechQueue` speaks them one after another and can be told to stop.
 *  - `createStreamSpeaker` joins them for one reply: feed it the deltas, `finish()` when the reply ends.
 *
 * What the splitter will not do is guess. "48." might be the end of a sentence or the start of "48.2", so a full stop
 * at the very end of what has arrived waits for the next character; the Chinese stops (。！？) end a sentence at once
 * because nothing can follow them that changes that. And what is spoken is what was written: markdown that a model
 * puts around its answer (`**Status:** Online`, a bullet) is removed because it is formatting, not words — nothing
 * is added, and nothing that is a word is dropped.
 */

/** Sentence-ending marks that end a sentence immediately: nothing that follows can change it. */
const HARD = "。！？…";
/** Marks that end a sentence only if what follows is a break (space, newline, or the end of the reply). */
const SOFT = ".!?";
/** Closing quotes and brackets that belong to the sentence they close. */
const CLOSERS = "\"'”’）)」』】]";
/** Abbreviations whose full stop is not a sentence end. Lower case, without the stop. */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "u.s", "a.m", "p.m", "no", "approx"]);

export interface SentenceSplitter {
  /** Add text; returns the sentences that are now complete (possibly none). */
  push(delta: string): string[];
  /** The reply is over: whatever is left is a sentence. */
  flush(): string[];
}

export interface SplitterOptions {
  /** A sentence shorter than this is held and joined to the next one, so "Yes." does not become its own utterance. */
  minChars?: number;
  /** A run longer than this with no stop in it is cut at its last comma or space. */
  maxChars?: number;
}

export function createSentenceSplitter(o: SplitterOptions = {}): SentenceSplitter {
  const minChars = o.minChars ?? 12;
  const maxChars = o.maxChars ?? 220;
  let buffer = "";
  let held = "";   // complete sentences too short to speak alone

  const out: string[] = [];
  const emit = (raw: string, final: boolean): void => {
    const text = speakable(raw);
    if (!text) return;
    held = held ? `${held} ${text}` : text;
    if (final || held.length >= minChars) { out.push(held); held = ""; }
  };

  function drain(final: boolean): void {
    for (;;) {
      const cut = boundary(buffer, final, maxChars);
      if (cut === -1) return;
      emit(buffer.slice(0, cut), final);
      buffer = buffer.slice(cut);
    }
  }

  return {
    push(delta) {
      buffer += delta;
      out.length = 0;
      drain(false);
      return [...out];
    },
    flush() {
      out.length = 0;
      drain(true);
      emit(buffer, true);
      buffer = "";
      if (held) { out.push(held); held = ""; }
      return [...out];
    },
  };
}

/** Index just past the first complete sentence in `text`, or -1 if none is known to be complete yet. */
function boundary(text: string, final: boolean, maxChars: number): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n") {
      // A line break is a break: bullets and headings are written one per line.
      if (text.slice(0, i).trim()) return i + 1;
      continue;
    }
    const hard = HARD.includes(c), soft = SOFT.includes(c);
    if (!hard && !soft) continue;
    // Swallow a run of marks and closing quotes: `?!`, `...`, `."`.
    let end = i + 1;
    while (end < text.length && (HARD.includes(text[end]!) || SOFT.includes(text[end]!) || CLOSERS.includes(text[end]!))) end++;
    if (end === text.length && !final && !hard) return -1;                    // might be "48." of "48.2"
    const next = text[end];
    if (hard && !SOFT.includes(c)) return consume(text, end);                  // 。！？… end it now
    if (next !== undefined && !/\s/.test(next)) { i = end - 1; continue; }     // "48.2", "e.g.x", "a.b"
    if (c === "." && isAbbreviation(text, i)) { i = end - 1; continue; }
    return consume(text, end);
  }
  if (text.length > maxChars) {
    const window = text.slice(0, maxChars);
    const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("，"), window.lastIndexOf("、"), window.lastIndexOf(" "));
    if (at > maxChars / 3) return at + 1;
  }
  return -1;
}

/** `end` plus the whitespace after it, so the next sentence does not start with a space. */
function consume(text: string, end: number): number {
  let e = end;
  while (e < text.length && /[ \t]/.test(text[e]!)) e++;
  return e;
}

function isAbbreviation(text: string, dot: number): boolean {
  const before = text.slice(0, dot);
  // The word must start at a boundary: the V of "TV" is not an initial, and "TV." ends a sentence.
  const raw = /(?:^|[^A-Za-z.])([A-Za-z]+(?:\.[A-Za-z]+)*)$/.exec(before)?.[1];
  if (!raw) return false;
  if (ABBREVIATIONS.has(raw.toLowerCase())) return true;
  return /^[A-Z]$/.test(raw);                                               // a single capital: an initial, "J. Smith"
}

/**
 * The words of a piece of text, without the formatting a model wraps them in.
 *
 * Removed: emphasis markers, code ticks, heading hashes, a leading bullet or number-dot, a link's address (its text is
 * kept), and runs of whitespace. Kept: everything else, including punctuation, which carries the prosody.
 */
export function speakable(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*{1,3}|_{2,3}|`{1,3})/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- the queue ------------------------------------------------------------------------------------------------

export interface SpeechQueue {
  /** Speak this after everything already queued. A no-op once cancelled. */
  enqueue(text: string): void;
  /** Resolves when everything queued so far has been spoken (or failed, or been cancelled). Never rejects. */
  idle(): Promise<void>;
  /** Drop what has not started. The sentence being spoken is allowed to end — the engine cannot be recalled mid-word. */
  cancel(): void;
  /** How many sentences have been handed to the speaker. */
  readonly spoken: number;
}

export function createSpeechQueue(speak: (text: string) => Promise<void> | void, onError?: (err: unknown, text: string) => void): SpeechQueue {
  let tail: Promise<void> = Promise.resolve();
  let cancelled = false;
  let spoken = 0;
  return {
    enqueue(text) {
      if (cancelled || !text.trim()) return;
      tail = tail.then(async () => {
        if (cancelled) return;
        spoken++;
        // A sentence that fails to speak must not silence the ones after it: the text already went to stdout.
        try { await speak(text); } catch (err) { onError?.(err, text); }
      });
    },
    idle: () => tail.then(() => undefined, () => undefined),
    cancel() { cancelled = true; },
    get spoken() { return spoken; },
  };
}

// ---- one reply ------------------------------------------------------------------------------------------------

export interface StreamSpeaker {
  /** Feed one streamed delta. */
  onDelta(delta: string): void;
  /** The reply ended: speak what is left and wait until everything has been said. */
  finish(): Promise<void>;
  /** Stop speaking what has not started (a new command, an error). */
  cancel(): void;
  /** Whether anything at all was spoken from the stream — if not, the caller speaks the whole reply itself. */
  readonly spokeAnything: boolean;
  /** Milliseconds from the first delta to the first sentence being handed to the speaker, once known. */
  readonly firstSentenceMs: number | undefined;
}

export function createStreamSpeaker(
  speak: (text: string) => Promise<void> | void,
  o: { onError?: (err: unknown, text: string) => void; now?: () => number } & SplitterOptions = {},
): StreamSpeaker {
  const now = o.now ?? Date.now;
  const splitter = createSentenceSplitter(o);
  const queue = createSpeechQueue(speak, o.onError);
  let first: number | undefined, firstSentenceMs: number | undefined;
  const give = (sentences: string[]): void => {
    for (const s of sentences) {
      if (firstSentenceMs === undefined && first !== undefined) firstSentenceMs = now() - first;
      queue.enqueue(s);
    }
  };
  return {
    onDelta(delta) {
      if (!delta) return;
      first ??= now();
      give(splitter.push(delta));
    },
    async finish() {
      give(splitter.flush());
      await queue.idle();
    },
    cancel() { queue.cancel(); },
    get spokeAnything() { return queue.spoken > 0; },
    get firstSentenceMs() { return firstSentenceMs; },
  };
}
