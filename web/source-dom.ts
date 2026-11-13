// Maps DOM ranges in the rendered Markdown document to and from raw source offsets.
// Blocks are the `[data-source-line]` wrappers MarkdownDocument emits.
import type { Quote } from '../src/store.ts';
import { locateQuote, selectionNodes, selectionText } from './selection.ts';
import { blockMap, sameVisible, sourceSpan, visibleSpan, type BlockKind, type BlockMap } from './source-map.ts';

type Block = { el: HTMLElement; start: number; end: number; kind: string };

const KINDS = new Set(['paragraph', 'heading', 'blockquote', 'list-item', 'code', 'hr', 'table', 'html', 'directive', 'math']);

function blocksOf(root: HTMLElement, source: string): Block[] {
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const wrappers = Array.from(root.querySelectorAll<HTMLElement>('[data-source-line]'));
  return wrappers.flatMap((el, i) => {
    const start = lineStarts[Number(el.dataset.sourceLine) - 1];
    if (start === undefined) return [];
    const next = wrappers[i + 1] && lineStarts[Number(wrappers[i + 1].dataset.sourceLine) - 1];
    let end = Math.max(start, next ?? source.length);
    // Trailing blank lines (and a CR before the line break) are not part of the block.
    while (end > start && /\s/.test(source[end - 1])) end--;
    return [{ el, start, end, kind: el.dataset.blockType ?? '' }];
  });
}

/** The block's map, only when its DOM text agrees with it character for character. */
function trustedMap(source: string, block: Block): BlockMap | null {
  if (!KINDS.has(block.kind)) return null;
  const map = blockMap(source.slice(block.start, block.end), block.kind as BlockKind);
  return map && sameVisible(map.visible, selectionText(block.el).replace(/\r$/, '')) ? map : null; // CRLF paragraphs render a trailing CR
}

function visibleOffset(block: HTMLElement, container: Node, offset: number) {
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(container, offset);
  return selectionText(before.cloneContents()).length;
}

export function rangeToSource(root: HTMLElement, source: string, range: Range): { start: number; end: number } | null {
  let start = -1, end = -1;
  for (const block of blocksOf(root, source)) {
    if (!range.intersectsNode(block.el)) continue;
    const inside = document.createRange();
    inside.selectNodeContents(block.el);
    // Endpoints between blocks snap to the nearest block boundary inside the selection.
    const from = inside.comparePoint(range.startContainer, range.startOffset);
    const to = inside.comparePoint(range.endContainer, range.endOffset);
    if (from > 0 || to < 0) continue;
    const text = selectionText(block.el);
    const a = from < 0 ? 0 : visibleOffset(block.el, range.startContainer, range.startOffset);
    const b = to > 0 ? text.length : visibleOffset(block.el, range.endContainer, range.endOffset);
    if (!text.slice(a, b).trim()) continue;
    const map = trustedMap(source, block);
    const span = map ? sourceSpan(map, a, b) : { start: 0, end: block.end - block.start };
    if (start < 0) start = block.start + span.start;
    end = block.start + span.end;
  }
  return start >= 0 && source.slice(start, end).trim() ? { start, end } : null;
}

function domRange(nodes: Text[], a: number, b: number): Range | null {
  const range = document.createRange();
  let at = 0, started = false;
  for (const node of nodes) {
    const length = node.data.length;
    if (!started && at + length > a) { range.setStart(node, a - at); started = true; }
    if (started && at + length >= b) { range.setEnd(node, b - at); return range; }
    at += length;
  }
  return null;
}

export function sourceToRanges(root: HTMLElement, source: string, start: number, end: number): Range[] {
  const ranges: Range[] = [];
  for (const block of blocksOf(root, source)) {
    const from = Math.max(start, block.start), to = Math.min(end, block.end);
    if (from >= to) continue;
    const nodes = selectionNodes(block.el);
    const map = trustedMap(source, block);
    const visible = map && visibleSpan(map, from - block.start, to - block.start);
    const range = domRange(nodes, visible ? visible.start : 0, visible ? visible.end : selectionText(block.el).length);
    if (range) ranges.push(range);
  }
  return ranges;
}

/** One range from the first to the last painted point of a quote, for positioning and scrolling. */
export function quoteSourceRange(root: HTMLElement, source: string, quote: Quote, version?: string): Range | null {
  const match = locateQuote(source, quote, version);
  const ranges = match ? sourceToRanges(root, source, match.start, match.end) : [];
  if (!ranges.length) return null;
  const range = ranges[0].cloneRange();
  range.setEnd(ranges[ranges.length - 1].endContainer, ranges[ranges.length - 1].endOffset);
  return range;
}
