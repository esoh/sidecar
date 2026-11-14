import type { FileQuote } from '../src/quote.ts';

/** Where a source-line quote's text sits now: the occurrence whose start line is nearest the quoted one (earlier on a tie). */
export function locateFileQuote(source: string, quote: FileQuote): { from: number; to: number } | null {
  const wanted = quote.startLine ?? 1;
  let best = -1, bestDistance = Infinity, line = 1, scanned = 0;
  for (let at = source.indexOf(quote.exact); at >= 0; at = source.indexOf(quote.exact, at + 1)) {
    // Count newlines only between successive occurrences, so the whole scan is linear.
    for (let newline = source.indexOf('\n', scanned); newline >= 0 && newline < at; newline = source.indexOf('\n', scanned)) { line++; scanned = newline + 1; }
    const distance = Math.abs(line - wanted);
    if (distance < bestDistance) { best = at; bestDistance = distance; }
    if (line > wanted) break;
  }
  return best < 0 ? null : { from: best, to: best + quote.exact.length };
}
