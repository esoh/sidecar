import type { Quote } from '../src/store.ts';
export function locateQuote(text: string, quote: Quote) {
  if (!quote.exact) return null;
  const matches = [];
  for (let at = text.indexOf(quote.exact); at !== -1; at = text.indexOf(quote.exact, at + 1)) {
    const end = at + quote.exact.length;
    if (
      text.slice(Math.max(0, at - quote.prefix.length), at) === quote.prefix &&
      text.slice(end, end + quote.suffix.length) === quote.suffix
    )
      matches.push({ start: at, end });
    if (matches.length > 1) return null;
  }
  return matches[0] ?? null;
}

export const excludedSelection =
  '.annotation-exclude, button, input, textarea, svg, style, script, .katex, [aria-hidden="true"]';
export function selectionNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(excludedSelection) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  let node;
  while ((node = walker.nextNode())) if (node instanceof Text) nodes.push(node);
  return nodes;
}
export const selectionText = (root: Node) =>
  selectionNodes(root)
    .map((node) => node.textContent ?? '')
    .join('');

// Convert our UTF-16 text anchors to text-node endpoints for web-highlighter.
export function quoteRange(article: HTMLElement, quote: Quote): Range | null {
  const match = locateQuote(selectionText(article), quote);
  if (!match) return null;
  const range = document.createRange();
  let at = 0,
    started = false;
  for (const node of selectionNodes(article)) {
    const length = node.textContent?.length ?? 0;
    if (!started && at + length > match.start) {
      range.setStart(node, match.start - at);
      started = true;
    }
    if (started && at + length >= match.end) {
      range.setEnd(node, match.end - at);
      return range;
    }
    at += length;
  }
  return null;
}
