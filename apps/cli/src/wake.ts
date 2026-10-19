/**
 * What was said to us, or `undefined` if the room was not talking to us.
 *
 * With no wake word everything counts. With one, the utterance has to contain
 * it, and what comes after is the command: "hearth turn it down" → "turn it
 * down". Matching is loose on purpose — a transcriber hands back "Hearth,",
 * "hearth." and "Harth" for the same sound — so punctuation is ignored and the
 * word may appear anywhere, which also covers "turn it down, hearth".
 *
 * **Mishearings.** The first live run on the Pi heard "hearth, turn off the light" as "Hard turn off light." and
 * dropped it as not for us. A transcriber has no obligation to spell a made-up word, so the word has *aliases*:
 * spellings it is known to produce. They are weaker evidence than the word itself — "hard" and "heart" are
 * ordinary English — so an alias counts only as the **first word** of the utterance (after an optional "hey" or
 * "ok") and only when a command follows it. "That is hard to say" is not for us; "hard, turn it down" is. The word
 * itself still counts anywhere. `HEARTH_WAKE_ALIASES=off` turns aliases off; a comma list replaces the built-in one.
 */

/** Spellings a transcriber has been seen to produce for a wake word. Add to this when a real run shows another. */
const BUILTIN_ALIASES: Record<string, string[]> = {
  hearth: ["hard", "harth", "hart", "heart", "hurth", "herth"],
};

/** Punctuation that separates words, in English and Chinese. */
const BREAK = "\\s,.!?;:\"'，。！？、";

export interface WakeMatch {
  /** What was asked, with the wake word and its punctuation removed. May be empty: the word alone. */
  command: string;
  /** `word` for the wake word itself; the alias that stood in for it otherwise. */
  via: "word" | { alias: string };
}

export function matchWake(text: string, wakeWord: string | undefined, aliases?: readonly string[] | false): WakeMatch | undefined {
  const spoken = text.trim();
  if (!wakeWord) return { command: spoken, via: "word" };
  const word = wakeWord.trim().toLowerCase();
  const pattern = new RegExp(`(^|[${BREAK}])${escapeRegExp(word)}(?=$|[${BREAK}])`, "i");
  const hit = pattern.exec(spoken);
  if (hit) {
    const before = spoken.slice(0, hit.index).trim();
    const after = spoken.slice(hit.index + hit[0].length).trim();
    return { command: tidy([before, after].filter(Boolean).join(" ")), via: "word" };
  }
  if (aliases === false) return undefined;
  const known = (aliases ?? BUILTIN_ALIASES[word] ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!known.length) return undefined;
  // First word only, after an optional greeting; a command must follow.
  const first = new RegExp(`^(?:(?:hey|hi|ok|okay)[${BREAK}]+)?([^${BREAK}]+)[${BREAK}]+(.+)$`, "i").exec(spoken);
  if (!first) return undefined;
  const alias = first[1]!.toLowerCase();
  if (!known.includes(alias)) return undefined;
  const command = tidy(first[2]!);
  return command ? { command, via: { alias } } : undefined;
}

export function afterWakeWord(text: string, wakeWord: string | undefined, aliases?: readonly string[] | false): string | undefined {
  return matchWake(text, wakeWord, aliases)?.command;
}

/** `HEARTH_WAKE_ALIASES`: `off` / `none` → no aliases; a comma list → exactly those; absent → the built-in ones. */
export function parseWakeAliases(value: string | undefined): readonly string[] | false | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^(off|none|false|0)$/i.test(v)) return false;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function tidy(s: string): string {
  return s.replace(/^[,.!?;:，。！？、\s]+|[,.!?;:，。！？、\s]+$/g, "").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
