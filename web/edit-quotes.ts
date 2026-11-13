import type { FileQuote } from '../src/quote.ts';

/** Where a source-line quote's text sits now: the occurrence whose start line is nearest the quoted one (earlier on a tie). */
export function locateFileQuote(source: string, quote: FileQuote): { from: number; to: number } | null {
  const starts: number[] = [];
  for (let at = source.indexOf(quote.exact); at >= 0; at = source.indexOf(quote.exact, at + 1)) starts.push(at);
  if (!starts.length) return null;
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const wanted = quote.startLine ?? 1;
  const from = starts.reduce((best, at) => Math.abs(lineOf(at) - wanted) < Math.abs(lineOf(best) - wanted) ? at : best);
  return { from, to: from + quote.exact.length };
}
