/** Approximate rendered width in em: full-width (CJK) characters ≈ 1em, others ≈ 0.56em. */
export function emWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.56;
  return w;
}

/** Greedy wrap by estimated width: break at spaces when possible; CJK text (no spaces) breaks between characters. */
export function wrap(s: string, maxEm: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const token of s.trim().split(/(\s+)/)) {
    for (const piece of /\s/.test(token) || emWidth(token) <= maxEm ? [token] : [...token]) {
      if (emWidth(line + piece) > maxEm && line.trim()) {
        // Keep one trailing space at word breaks so the concatenated text equals the original (accessible name).
        lines.push(/\s/.test(piece) ? `${line.trim()} ` : line.replace(/^\s+/, '').replace(/\s+$/, ' '));
        line = /\s/.test(piece) ? '' : piece;
      } else {
        line += piece;
      }
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}



