import { useLayoutEffect, type MutableRefObject } from 'react';
import type { Quote } from '../src/store.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { excludedSelection, locateQuote } from './selection.ts';
import { sourceToRanges } from './source-dom.ts';

const wrappers = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-source-line]')].filter(node => (node.firstElementChild?.getClientRects().length ?? 0) > 0);

/** The source line of the first block that starts at or below the pane's top edge. */
export function previewTopLine(scroller: HTMLElement, root: HTMLElement): number {
  const top = scroller.getBoundingClientRect().top;
  const first = wrappers(root).find(node => node.firstElementChild!.getBoundingClientRect().top >= top - 1);
  return Number(first?.dataset.sourceLine) || 1;
}
export function scrollPreviewToLine(scroller: HTMLElement, root: HTMLElement, line: number): void {
  const block = wrappers(root).filter(node => Number(node.dataset.sourceLine) <= line).at(-1)?.firstElementChild;
  if (block) scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

const HIGHLIGHT = 'sidecar-quote';

/**
 * The rendered Markdown of the editor's text, with the threads' quotes painted. The quotes use the CSS Custom
 * Highlight API, which leaves the DOM React owns untouched, so the document is patched in place (never remounted)
 * and keeps its scroll position and folded headings.
 */
export function EditPreview({ text, documentId, linkBase, quotes, version, rootRef, scrollRef, rangesRef, onRange, onOpenQuote }: {
  text: string; documentId: string; linkBase?: string;
  quotes: Array<{ id: string; quote: Quote }>;
  /** The version `text` is the source of, or undefined while it holds unsaved edits. */
  version?: string;
  rootRef: MutableRefObject<HTMLElement | null>; scrollRef: MutableRefObject<HTMLDivElement | null>;
  /** Where each painted quote sits in the rendered text. */
  rangesRef: MutableRefObject<Map<string, Range[]>>;
  /** A finished selection in the rendered text, with the text it was rendered from. */
  onRange: (range: Range, rendered: string) => void;
  onOpenQuote: (id: string) => void;
}) {
  const quoteKey = JSON.stringify(quotes);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const painted = new Map<string, Range[]>();
    for (const { id, quote } of quotes) {
      const match = locateQuote(text, quote, version), ranges = match ? sourceToRanges(root, text, match.start, match.end) : [];
      if (ranges.length) painted.set(id, ranges);
    }
    rangesRef.current = painted;
    CSS.highlights.set(HIGHLIGHT, new Highlight(...[...painted.values()].flat()));
    return () => { CSS.highlights.delete(HIGHLIGHT); rangesRef.current = new Map(); };
  }, [text, quoteKey, version]);
  const capture = () => {
    const selected = window.getSelection(), root = rootRef.current;
    if (!root || !selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    if (root.contains(range.startContainer) && root.contains(range.endContainer) && ![range.startContainer, range.endContainer].some(node => node.parentElement?.closest(excludedSelection))) onRange(range, text);
  };
  return (
    <div className="edit-preview" ref={scrollRef}>
      <article className="edit-preview-article" aria-label="Preview" ref={rootRef} tabIndex={-1}
        onMouseUp={capture} onTouchEnd={capture}
        onKeyUp={event => { if (event.key.startsWith('Arrow') || event.key === 'Shift') capture(); }}
        onClick={event => {
          if (!window.getSelection()?.isCollapsed) return;
          const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
          const at = caret ? { node: caret.offsetNode, offset: caret.offset } : (() => { const range = document.caretRangeFromPoint?.(event.clientX, event.clientY); return range && { node: range.startContainer, offset: range.startOffset }; })();
          const hit = at && [...rangesRef.current].find(([, ranges]) => ranges.some(range => range.comparePoint(at.node, at.offset) === 0));
          if (hit) { event.preventDefault(); onOpenQuote(hit[0]); }
        }}>
        <MarkdownDocument markdown={text} documentId={documentId} linkBase={linkBase} canCollapseHeadings sourceLines />
      </article>
    </div>
  );
}
