import type { Quote } from '../src/store.ts';
// Plannotator smartens prose quotes. These substitutions retain UTF-16 offsets
// so both saved source anchors and browser selections locate the same DOM range.
const plainQuotes = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
export function locateQuote(text: string, quote: Quote) {
  if (!quote.exact) return null;
  text = plainQuotes(text);
  const exact = plainQuotes(quote.exact), prefix = plainQuotes(quote.prefix), suffix = plainQuotes(quote.suffix);
  const matches = [];
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    const end = at + exact.length;
    if (
      text.slice(Math.max(0, at - prefix.length), at) === prefix &&
      text.slice(end, end + suffix.length) === suffix
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

// Sentence context is optional: never truncate the user's selection or attach a long paragraph.
export function surroundingSentence(text: string, start: number, end: number): string | undefined {
  const exact = text.slice(start, end).trim();
  for (const { segment, index } of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
    if (index > start) break;
    if (start >= index && end <= index + segment.length) {
      const sentence = segment.trim();
      return sentence.length <= 512 && sentence !== exact ? sentence : undefined;
    }
  }
  return undefined;
}

export function selectionSentence(range: Range): string | undefined {
  const common = range.commonAncestorContainer;
  const element = common instanceof Element ? common : common.parentElement;
  const block = element?.closest('p, li, blockquote, pre, td, th, h1, h2, h3, h4, h5, h6');
  if (!block) return undefined;
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const start = selectionText(before.cloneContents()).length;
  before.setEnd(range.endContainer, range.endOffset);
  return surroundingSentence(selectionText(block), start, selectionText(before.cloneContents()).length);
}

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
