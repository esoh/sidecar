import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Highlighter from '@plannotator/web-highlighter';
import { onCodeHighlightSwap } from '@plannotator/ui/utils/codeHighlight';
import type { Quote } from '../src/store.ts';
import { api, errorText } from './api.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { excludedSelection, matchQuote, quoteRange, resolveQuote, selectionText, type TextMatch } from './selection.ts';

export function OriginalDocument({
  documentId,
  threadId,
  selectionId,
  quote,
  onReturn,
}: {
  documentId: string;
  threadId: string;
  selectionId: string;
  quote: Quote;
  onReturn: () => void;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null),
    [error, setError] = useState('');
  const [renderedText, setRenderedText] = useState('');
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState('');
  useEffect(() => { setSaveError(''); }, [quote.prefix, quote.suffix, quote.start, quote.end]);
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
      setRenderedText(selectionText(root));
      const range = quoteRange(root, quote, quote.version);
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
  }, [markdown, quote.exact, quote.prefix, quote.suffix, quote.start, quote.end, quote.isPositionVerified, quote.version]);
  const match = markdown === null ? null : matchQuote(renderedText, quote, quote.version);
  async function choose(location: TextMatch) {
    if (saving) return;
    setSaving(true); setSaveError('');
    try {
      const clarified = resolveQuote(renderedText, quote, location);
      await api(`/api/threads/${threadId}/selections/${selectionId}/anchor`, { expectedQuote: quote, quote: clarified });
    } catch (reason) { setSaveError(errorText(reason)); }
    finally { setSaving(false); }
  }
  return (
    <section className="original-document" aria-label="Original document">
      <div className="original-banner">
        <span>Original document · Read-only</span>
        <button onClick={onReturn}>Return to current</button>
      </div>
      {!error && match && match.status !== 'found' && <div className="original-selection-issue">
        <p role="status">{match.status === 'ambiguous' ? 'Multiple matching passages. Choose the intended passage in this saved version.' : match.status === 'context-changed' ? 'The saved context does not match. Choose the intended passage.' : 'The selection could not be found in this saved version.'}</p>
        {match.matches.length > 0 && <div className="passage-candidates" role="group" aria-label="Choose matching passage">{match.matches.map((location, index) => <button key={location.start} disabled={saving} aria-label={`Use passage ${index + 1}`} aria-describedby={`candidate-${selectionId}-${index}`} onClick={() => { void choose(location); }}>
          <span className="passage-number">{index + 1}</span><span id={`candidate-${selectionId}-${index}`}>{location.start > 80 ? '…' : ''}{renderedText.slice(Math.max(0, location.start - 80), location.start)}<strong>{renderedText.slice(location.start, location.end)}</strong>{renderedText.slice(location.end, location.end + 80)}{location.end + 80 < renderedText.length ? '…' : ''}</span>
        </button>)}</div>}
        {saveError && <p role="alert">{saveError}</p>}
      </div>}
      {error ? (
        <p role="alert">{error}</p>
      ) : markdown === null ? (
        <p role="status">Loading original document…</p>
      ) : (
        <article
          ref={article}
          className="document-card w-full bg-card rounded-xl p-5 md:p-8 lg:p-10 xl:p-12 shadow-xl border border-border/50"
        >
          <MarkdownDocument markdown={markdown} documentId={documentId} anchorPrefix={`original-${selectionId}-`} />
        </article>
      )}
    </section>
  );
}
