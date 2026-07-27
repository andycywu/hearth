/**
 * Greedy line wrapping that works for both space-separated (Latin) and
 * character-dense (CJK) text. `measure` returns the rendered width of a string
 * (e.g. `ctx.measureText(s).width`); pure and unit-testable without a canvas.
 */
export function wrapLines(measure: (s: string) => number, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (ch === "\n") {
      lines.push(cur);
      cur = "";
      continue;
    }
    const next = cur + ch;
    if (cur && measure(next) > maxWidth) {
      lines.push(cur);
      cur = ch === " " ? "" : ch;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
