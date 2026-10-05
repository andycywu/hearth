/**
 * What was said to us, or `undefined` if the room was not talking to us.
 *
 * With no wake word everything counts. With one, the utterance has to contain
 * it, and what comes after is the command: "hearth turn it down" → "turn it
 * down". Matching is loose on purpose — a transcriber hands back "Hearth,",
 * "hearth." and "Harth" for the same sound — so punctuation is ignored and the
 * word may appear anywhere, which also covers "turn it down, hearth".
 */
export function afterWakeWord(text: string, wakeWord: string | undefined): string | undefined {
  const spoken = text.trim();
  if (!wakeWord) return spoken;
  const word = wakeWord.trim().toLowerCase();
  const pattern = new RegExp(`(^|[\\s,.!?;:"'，。！？、])${escapeRegExp(word)}(?=$|[\\s,.!?;:"'，。！？、])`, "i");
  const hit = pattern.exec(spoken);
  if (!hit) return undefined;
  const before = spoken.slice(0, hit.index).trim();
  const after = spoken.slice(hit.index + hit[0].length).trim();
  return [before, after].filter(Boolean).join(" ").replace(/^[,.!?;:，。！？、\s]+|[,.!?;:，。！？、\s]+$/g, "").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
