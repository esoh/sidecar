import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Highlighter from '@plannotator/web-highlighter';
import { onCodeHighlightSwap } from '@plannotator/ui/utils/codeHighlight';
import type { Quote } from '../src/store.ts';
import { api, errorText } from './api.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { excludedSelection, quoteRange } from './selection.ts';

export function OriginalDocument({
  documentId,
  threadId,
  quote,
  onReturn,
}: {
  documentId: string;
  threadId: string;
  quote: Quote;
  onReturn: () => void;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null),
    [error, setError] = useState('');
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    let stopped = false;
    api<{ markdown: string }>(`/api/documents/${documentId}/versions/${encodeURIComponent(quote.version)}`)
      .then((saved) => {
        if (!stopped) setMarkdown(saved.markdown);
      })
      .catch((reason) => {
        if (!stopped) setError(errorText(reason));
      });
    return () => { stopped = true; };
  }, [documentId, quote.version]);
  useLayoutEffect(() => {
    const root = article.current;
    if (!root || markdown === null) return;
    const painter = new Highlighter({
      $root: root,
      wrapTag: 'mark',
      exceptSelectors: [excludedSelection],
      style: { className: 'annotation-highlight' },
    });
    let frame = 0,
      hasScrolled = false;
    const paint = () => {
      painter.removeAll();
      const range = quoteRange(root, quote);
      if (!range) return;
      painter.fromRange(range);
      for (const mark of painter.getDoms()) mark.setAttribute('data-active', '');
      if (!hasScrolled) {
        painter.getDoms()[0]?.scrollIntoView({ block: 'center' });
        hasScrolled = true;
      }
    };
    paint();
    const unsubscribe = onCodeHighlightSwap((element) => {
      if (!root.contains(element)) return;
      painter.removeAll();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      painter.dispose();
    };
  }, [markdown, quote.exact, quote.prefix, quote.suffix]);
  return (
    <section className="original-document" aria-label="Original document">
      <div className="original-banner">
        <span>Original document · Read-only</span>
        <button onClick={onReturn}>Return to current</button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : markdown === null ? (
        <p role="status">Loading original document…</p>
      ) : (
        <article
          ref={article}
          className="document-card w-full bg-card rounded-xl p-5 md:p-8 lg:p-10 xl:p-12 shadow-xl border border-border/50"
        >
          <MarkdownDocument markdown={markdown} documentId={documentId} anchorPrefix={`original-${threadId}-`} />
        </article>
      )}
    </section>
  );
}
