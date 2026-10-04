import type { Thread } from '../src/store.ts';

export function threadMatch(thread: Thread, query: string): { before: string; match: string; after: string } | null {
  const needle = query.trim().replace(/\s+/g, ' ');
  if (!needle) return null;
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  for (const source of [...thread.messages.flatMap(message => [message.text, ...(message.fileQuote ? [message.fileQuote.path, message.fileQuote.exact] : []), ...(message.selections ?? []).flatMap(selection => [selection.quote.exact, selection.label ?? ''])]), thread.title ?? '']) {
    const text = source.replace(/\s+/g, ' '), match = pattern.exec(text);
    if (!match) continue;
    const start = Math.max(0, match.index - 45), end = Math.min(text.length, match.index + match[0].length + 100);
    return {
      before: (start ? '…' : '') + text.slice(start, match.index),
      match: match[0],
      after: text.slice(match.index + match[0].length, end) + (end < text.length ? '…' : ''),
    };
  }
  return null;
}
