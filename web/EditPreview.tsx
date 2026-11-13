import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import Highlighter from '@plannotator/web-highlighter';
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

/** The rendered Markdown of the editor's text, with the threads' quotes painted. */
export function EditPreview({ text, documentId, linkBase, quotes, version, rootRef, scrollRef, onRange, onOpenQuote }: {
  text: string; documentId: string; linkBase?: string;
  quotes: Array<{ id: string; quote: Quote }>;
  /** The version `text` is the source of, or undefined while it holds unsaved edits. */
  version?: string;
  rootRef: MutableRefObject<HTMLElement | null>; scrollRef: MutableRefObject<HTMLDivElement | null>;
  /** A finished selection in the rendered text, with the text it was rendered from. */
  onRange: (range: Range, rendered: string) => void;
  onOpenQuote: (id: string) => void;
}) {
  // The highlighter rewrites text nodes React owns, so a tree that was painted is replaced rather than patched.
  const tainted = useRef(false), painter = useRef<Highlighter | null>(null);
  const [shown, setShown] = useState({ text, epoch: 0 });
  if (shown.text !== text) { setShown({ text, epoch: shown.epoch + (tainted.current ? 1 : 0) }); tainted.current = false; }
  const quoteKey = JSON.stringify(quotes);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const highlighter = new Highlighter({ $root: root, wrapTag: 'mark', exceptSelectors: [excludedSelection], style: { className: 'annotation-highlight' } });
    painter.current = highlighter;
    let paintingId = '';
    const release = highlighter.hooks.Render.UUID.tap(() => paintingId);
    for (const { id, quote } of quotes) {
      for (const mark of highlighter.getDoms()) mark.normalize();
      const match = locateQuote(shown.text, quote, version);
      const ranges = match ? sourceToRanges(root, shown.text, match.start, match.end) : [];
      paintingId = id;
      for (const range of ranges) { highlighter.fromRange(range); tainted.current = true; }
    }
    release();
    for (const mark of highlighter.getDoms()) { mark.tabIndex = 0; mark.setAttribute('role', 'button'); mark.title = 'Open passage thread'; }
    return () => { try { highlighter.removeAll(); } catch { /* the tree it painted is already gone */ } highlighter.dispose(); if (painter.current === highlighter) painter.current = null; };
  }, [shown.epoch, shown.text, quoteKey, version]);
  const capture = () => {
    const selected = window.getSelection(), root = rootRef.current;
    if (!root || !selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    if (root.contains(range.startContainer) && root.contains(range.endContainer) && ![range.startContainer, range.endContainer].some(node => node.parentElement?.closest(excludedSelection))) onRange(range, shown.text);
  };
  return (
    <div className="edit-preview" ref={scrollRef}>
      <article key={shown.epoch} className="edit-preview-article" aria-label="Preview" ref={rootRef} tabIndex={-1}
        onMouseUp={capture} onTouchEnd={capture}
        onKeyUp={event => { if (event.key.startsWith('Arrow') || event.key === 'Shift') capture(); }}
        onClick={event => {
          const mark = event.target instanceof Element ? event.target.closest('mark') : null, highlighter = painter.current;
          const id = mark && highlighter && [highlighter.getIdByDom(mark), ...highlighter.getExtraIdByDom(mark)].find(id => quotes.some(item => item.id === id));
          if (id) { event.preventDefault(); onOpenQuote(id); }
        }}>
        <MarkdownDocument markdown={shown.text} documentId={documentId} linkBase={linkBase} canCollapseHeadings sourceLines />
      </article>
    </div>
  );
}
