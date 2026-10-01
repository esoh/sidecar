import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import Highlighter from '@plannotator/web-highlighter';
import type { DocumentRecord, Quote, RequestRecord, State, Thread } from '../src/store.ts';
import { locateQuote, quoteRange } from './selection.ts';

type ViewerState = Omit<State, 'documents'> & {
  documents: Record<string, DocumentRecord & { title: string; version: string | null; error: string | null }>;
  activity: string; connectionError: string | null;
  stream: { threadId: string; text: string; error: string | null } | null;
};
type Content = { html: string; version: string };
type QuestionDraft = { text: string; retry: { signature: string; id: string } | null };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed: ${response.status}`);
  return result;
}
function openThread(id: string) {
  const view = document.getElementById(`thread-${id}`);
  view?.scrollIntoView({ block: 'center' }); view?.focus({ preventScroll: true });
}

// Placement adapted from Plannotator's CommentPopover (MIT); see THIRD_PARTY_NOTICES.md.
function usePosition(ref: RefObject<HTMLElement | null>, anchor: (() => DOMRect | undefined) | null, width: number) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !anchor) return;
    const update = () => {
      const rect = anchor();
      if (!rect) return;
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8, topEdge = (viewport?.offsetTop ?? 0) + 8;
      const rightEdge = leftEdge + (viewport?.width ?? innerWidth) - 16, bottomEdge = topEdge + (viewport?.height ?? innerHeight) - 16;
      const size = Math.min(width, rightEdge - leftEdge);
      node.style.width = `${size}px`;
      node.style.maxHeight = `${bottomEdge - topEdge}px`;
      const height = node.offsetHeight;
      const below = bottomEdge - rect.bottom - 8, above = rect.top - topEdge - 8;
      const top = below < height && above > below ? rect.top - height - 8 : rect.bottom + 8;
      node.style.left = `${Math.max(leftEdge, Math.min(rect.left + rect.width / 2 - size / 2, rightEdge - size))}px`;
      node.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height))}px`;
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(node);
    window.addEventListener('scroll', update, true); window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update); window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect(); window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [ref, anchor, width]);
}

function QuestionForm({ documentId, threadId, quote, onSent, floating = false, onCancel, disabled = false, initialDraft, onDraftChange, onSendingChange }: {
  documentId: string; threadId?: string; quote?: Quote; onSent: (request: RequestRecord) => void;
  floating?: boolean; onCancel?: () => void; disabled?: boolean;
  initialDraft?: QuestionDraft; onDraftChange?: (draft: QuestionDraft) => void; onSendingChange?: (sending: boolean) => void;
}) {
  const [text, setText] = useState(initialDraft?.text ?? ''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null), sending = useRef(false);
  const retry = useRef(initialDraft?.retry ?? null);
  useLayoutEffect(() => { if (floating) input.current?.focus({ preventScroll: true }); }, [floating]);
  const cancel = () => { if (!sending.current) { setText(''); retry.current = null; onDraftChange?.({ text: '', retry: null }); setError(''); onCancel?.(); } };
  const id = threadId ? `follow-up-${threadId}` : floating ? 'comment-question' : 'question';
  return <form onSubmit={async event => {
    event.preventDefault();
    if (sending.current || !text.trim() || !documentId) return;
    const body = { documentId, text, ...(threadId ? { threadId } : quote ? { quote } : {}) };
    const signature = JSON.stringify(body);
    if (retry.current?.signature !== signature) retry.current = { signature, id: crypto.randomUUID() };
    onDraftChange?.({ text, retry: retry.current });
    sending.current = true; setBusy(true); onSendingChange?.(true);
    try {
      const request = await api<RequestRecord>('/api/questions', { ...body, clientMessageId: retry.current.id });
      setText(value => value === text ? '' : value); retry.current = null; onDraftChange?.({ text: '', retry: null }); setError(''); onSent(request);
    } catch (reason) { setError(errorText(reason)); }
    finally { sending.current = false; setBusy(false); onSendingChange?.(false); }
  }} onKeyDown={event => {
    if (floating && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.requestSubmit(); }
  }}>
    <label htmlFor={id}>{threadId ? 'Follow-up' : floating ? 'Comment' : 'Question'}</label><br />
    <textarea ref={input} id={id} required value={text} readOnly={floating && busy} onChange={event => { setText(event.target.value); onDraftChange?.({ text: event.target.value, retry: retry.current }); }} /><br />
    <p role="alert">{error}</p>
    <button disabled={disabled || busy}>{threadId ? 'Send follow-up' : 'Send'}</button>
    {floating && <button type="button" onClick={cancel} disabled={busy}>Cancel</button>}
  </form>;
}

function TitleForm({ id, title, onError }: { id: string; title: string; onError: (error: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <form onSubmit={async event => {
    event.preventDefault(); const value = draft ?? title;
    try { await api(`/api/documents/${id}/title`, { title: value }, 'PATCH'); setDraft(current => current === value ? null : current); }
    catch (reason) { onError(errorText(reason)); }
  }}><label htmlFor="title">Document title</label> <input id="title" value={draft ?? title} onChange={event => setDraft(event.target.value)} /> <button>Save title</button></form>;
}

function App() {
  const [state, setState] = useState<ViewerState | null>(null), [content, setContent] = useState<Content>({ html: '', version: '' });
  const [connected, setConnected] = useState(false), [error, setError] = useState(''), [documentError, setDocumentError] = useState('');
  const [selection, setSelection] = useState<Quote>(), [composing, setComposing] = useState(false);
  const [choices, setChoices] = useState<{ ids: string[]; rect: DOMRect } | null>(null);
  const article = useRef<HTMLElement>(null), composer = useRef<HTMLElement>(null), toolbar = useRef<HTMLDivElement>(null);
  const highlighter = useRef<Highlighter | null>(null), lastRect = useRef<DOMRect>(new DOMRect());
  const ignoreClick = useRef(false), pendingFocus = useRef<string | null>(null), sendingComment = useRef(false);
  const passageDrafts = useRef(new Map<string, QuestionDraft>());
  const draftKey = JSON.stringify(selection);
  const requestedDocument = new URL(location.href).searchParams.get('document');
  const documentId = requestedDocument ?? Object.keys(state?.documents ?? {})[0] ?? '';
  const current = state?.documents[documentId];
  const threads = Object.values(state?.threads ?? {}).filter(thread => thread.documentId === documentId);
  const clearSelection = useCallback(() => { setSelection(undefined); setComposing(false); setChoices(null); }, []);
  const openComment = useCallback(() => { setComposing(true); window.getSelection()?.removeAllRanges(); }, []);

  useEffect(() => {
    let stopped = false, refreshing = false, again = false, version = '';
    async function refresh() {
      if (refreshing) { again = true; return; }
      refreshing = true;
      try {
        do {
          again = false;
          const next = await api<ViewerState>('/api/state');
          if (stopped) return;
          setState(next);
          const id = requestedDocument ?? Object.keys(next.documents)[0] ?? '';
          const doc = next.documents[id];
          if (!doc) continue;
          document.title = doc.title; setDocumentError(doc.error ?? '');
          if (!version || (doc.version && version !== doc.version)) {
            try {
              const data = await api<Content>(`/api/documents/${id}`);
              if (stopped) return;
              version = data.version; setContent(data); setDocumentError('');
            } catch (reason) { if (!stopped) setDocumentError(errorText(reason)); }
          }
        } while (again && !stopped);
      } catch (reason) { if (!stopped) setError(errorText(reason)); }
      finally { refreshing = false; }
    }
    const events = new EventSource('/api/events');
    events.onopen = () => { setConnected(true); void refresh(); };
    events.onerror = () => setConnected(false);
    events.addEventListener('change', () => { void refresh(); });
    void refresh();
    return () => { stopped = true; events.close(); };
  }, [requestedDocument]);

  // React owns the article; only the highlighter touches its server-rendered contents.
  const markup = useMemo(() => ({ __html: content.html }), [content.html]);
  const documentText = useMemo(() => {
    const node = document.createElement('div'); node.innerHTML = content.html;
    return node.textContent ?? '';
  }, [content.html]);
  const anchors = JSON.stringify(threads.filter(thread => thread.quote).map(({ id, quote, isResolved }) => ({ id, quote, isResolved })));
  useLayoutEffect(() => {
    const root = article.current;
    if (!root) return;
    const painter = new Highlighter({ $root: root, wrapTag: 'mark', style: { className: 'annotation-highlight' } });
    highlighter.current = painter;
    return () => { painter.dispose(); highlighter.current = null; };
  }, []);
  useLayoutEffect(() => {
    const root = article.current, painter = highlighter.current;
    if (!root || !painter) return;
    let paintingId = '';
    const releaseId = painter.hooks.Render.UUID.tap(() => paintingId);
    const targets: { id: string; quote?: Quote; isResolved?: boolean }[] = JSON.parse(anchors);
    if (selection) targets.push({ id: 'selection', quote: selection });
    if (!documentError) for (const target of targets) {
      if (!target.quote) continue;
      const range = quoteRange(root, target.quote);
      if (!range) continue;
      paintingId = target.id;
      painter.fromRange(range);
    }
    for (const mark of painter.getDoms()) {
      const ids = [painter.getIdByDom(mark), ...painter.getExtraIdByDom(mark)];
      if (ids.includes('selection')) mark.dataset.pending = '';
      const saved = targets.filter(target => target.id !== 'selection' && ids.includes(target.id));
      if (saved.length) {
        mark.tabIndex = 0; mark.setAttribute('role', 'button'); mark.title = 'Open passage thread';
        if (saved.every(target => target.isResolved)) mark.dataset.resolved = '';
      }
    }
    return () => { releaseId(); painter.removeAll(); };
  }, [content.html, anchors, selection, documentError]);

  useEffect(() => {
    const outside = () => {
      const range = window.getSelection();
      if (!composing && range && !range.isCollapsed && !article.current?.contains(range.anchorNode)) clearSelection();
    };
    document.addEventListener('mouseup', outside);
    return () => document.removeEventListener('mouseup', outside);
  }, [composing, clearSelection]);
  // Use Plannotator's editable-target guards; C only acts while the selection toolbar is open.
  useEffect(() => {
    if (!selection || composing || choices) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== 'c') return;
      if ([event.target, document.activeElement].some(node => node instanceof Element && node.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])'))) return;
      event.preventDefault();
      openComment();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [selection, composing, choices, openComment]);
  // Like Plannotator, dismiss an empty composer without stealing the clicked target's focus.
  useEffect(() => {
    if (!composing) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || composer.current?.contains(event.target)) return;
      if (sendingComment.current || passageDrafts.current.get(draftKey)?.text.trim()) return;
      passageDrafts.current.delete(draftKey);
      clearSelection();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [composing, draftKey, clearSelection]);
  useLayoutEffect(() => {
    if (pendingFocus.current && threads.some(thread => thread.id === pendingFocus.current)) {
      openThread(pendingFocus.current); pendingFocus.current = null;
    }
  }, [threads]);
  const anchor = useCallback(() => {
    if (choices) return highlighter.current?.getDoms(choices.ids[0])[0]?.getBoundingClientRect() ?? choices.rect;
    const root = article.current;
    const range = root && selection && quoteRange(root, selection);
    if (range) lastRect.current = range.getBoundingClientRect();
    return lastRect.current;
  }, [selection, choices]);
  usePosition(composer, composing ? anchor : null, 384);
  usePosition(toolbar, (selection && !composing) || choices ? anchor : null, choices ? 300 : 100);

  function captureSelection() {
    if (sendingComment.current) return;
    const selected = window.getSelection(), root = article.current;
    if (!root || !selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const before = document.createRange(); before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length; before.setEnd(range.endContainer, range.endOffset);
    const end = before.toString().length, text = root.textContent ?? '', exact = text.slice(start, end);
    if (!exact.trim()) { clearSelection(); return; }
    lastRect.current = range.getBoundingClientRect();
    ignoreClick.current = true; requestAnimationFrame(() => { ignoreClick.current = false; });
    setSelection({ exact, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32), start, end, version: content.version });
    setComposing(false); setChoices(null);
  }
  function visitHighlight(target: EventTarget | null) {
    if (ignoreClick.current || sendingComment.current || !(target instanceof Element)) return;
    const mark = target.closest('mark'), painter = highlighter.current;
    if (!mark || !painter) return;
    const ids = [...new Set([painter.getIdByDom(mark), ...painter.getExtraIdByDom(mark)])].filter(id => threads.some(thread => thread.id === id));
    if (ids.length === 1) { clearSelection(); openThread(ids[0]); }
    else if (ids.length > 1) { setComposing(false); setSelection(undefined); setChoices({ ids, rect: mark.getBoundingClientRect() }); }
    return ids.length > 0;
  }
  const passageChanged = (quote: Quote) => !!documentError || !locateQuote(documentText, quote);
  const cancel = () => { if (!sendingComment.current) { clearSelection(); article.current?.focus({ preventScroll: true }); } };
  const sent = (request: RequestRecord) => { clearSelection(); pendingFocus.current = request.threadId; openThread(request.threadId); };
  return <>
    <h1>Sidecar</h1>
    <nav aria-label="Documents">{Object.values(state?.documents ?? {}).map(doc => <a key={doc.id} href={`/?document=${doc.id}`}>{doc.title}{' '}</a>)}</nav>
    <p role="status">{!connected ? 'Disconnected from Sidecar; reconnecting…' : state?.connectionError ?? (state?.activity === 'compacting' ? 'Compacting context' : state?.activity === 'responding' ? 'Agent is responding.' : 'Waiting for agent.')}</p>
    <p role="alert">{error}</p>
    <main>
      {current && <TitleForm id={documentId} title={current.title} onError={setError} />}
      <p data-testid="document-error" role="alert">{documentError || (!current && 'Open a document from your agent.')}</p>
      <article id="document" ref={article} tabIndex={-1} aria-label="Document" dangerouslySetInnerHTML={markup} onMouseUp={captureSelection} onTouchEnd={captureSelection}
        onClick={event => { if (visitHighlight(event.target)) event.preventDefault(); }} onKeyUp={event => { if (event.key.startsWith('Arrow') || event.key === 'Shift') captureSelection(); }}
        onKeyDown={event => {
          if (event.key === 'Escape') cancel();
          if (event.target instanceof HTMLElement && event.target.matches('mark') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); visitHighlight(event.target); }
        }} />
      {((selection && !composing) || choices) && createPortal(<div ref={toolbar} className="floating selection-actions" onKeyDown={event => { if (event.key === 'Escape') cancel(); }}>
        {choices ? choices.ids.map(id => <button key={id} onClick={() => { clearSelection(); openThread(id); }}>{threads.find(thread => thread.id === id)?.messages[0]?.text ?? 'Open thread'}</button>)
          : <button onClick={openComment} aria-keyshortcuts="c" title="Comment (C)">Comment</button>}
      </div>, document.body)}
      {composing && selection && createPortal(<section ref={composer} className="floating" role="dialog" aria-label="Comment on selection">
        <p>Selection: <span className="quote-preview" data-testid="selection-preview">{selection.exact + (passageChanged(selection) ? ' (Passage changed.)' : '')}</span></p>
        <QuestionForm key={draftKey} documentId={documentId} quote={selection} disabled={!current} floating onCancel={cancel} onSent={sent}
          initialDraft={passageDrafts.current.get(draftKey)} onDraftChange={draft => { if (draft.text || draft.retry) passageDrafts.current.set(draftKey, draft); else passageDrafts.current.delete(draftKey); }}
          onSendingChange={sending => { sendingComment.current = sending; }} />
      </section>, document.body)}
      <section aria-label="New question">
        <p>Whole document</p>
        <QuestionForm documentId={documentId} disabled={!current} onSent={sent} />
      </section>
      <h2>Threads</h2>
      <section id="threads" aria-label="Threads">{threads.map(thread => <fieldset key={thread.id} id={`thread-${thread.id}`} tabIndex={-1}>
        <legend>{thread.scope === 'passage' ? 'Passage thread' : 'Document thread'}</legend>
        <blockquote>{thread.quote?.exact ?? 'Whole document'}</blockquote>
        {thread.quote && passageChanged(thread.quote) && <p>Passage changed.</p>}
        {thread.messages.map(message => <p key={message.id}><strong>{message.role === 'user' ? 'You: ' : 'Agent: '}</strong><span>{message.text}</span></p>)}
        {state?.stream?.threadId === thread.id && state.stream.text && <p><strong>Agent (streaming): </strong><span>{state.stream.text}</span></p>}
        <p>{Object.values(state?.requests ?? {}).filter(request => request.threadId === thread.id && request.status !== 'completed').map(request => ({ queued: 'Queued; waiting for agent.', claimed: 'Agent is responding.', uncertain: 'Interrupted request; agent must check before retrying.', failed: 'Request failed.', completed: '' })[request.status]).join(' ')}{state?.stream?.threadId === thread.id && state.stream.error}</p>
        <button onClick={async () => { try { await api(`/api/threads/${thread.id}/resolution`, { isResolved: !thread.isResolved }); } catch (reason) { setError(errorText(reason)); } }}>{thread.isResolved ? 'Reopen' : 'Resolve'}</button>
        <QuestionForm documentId={documentId} threadId={thread.id} onSent={() => {}} />
      </fieldset>)}</section>
    </main>
  </>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
