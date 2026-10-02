import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import Highlighter from '@plannotator/web-highlighter';
import type { Quote, RequestRecord } from '../src/store.ts';
import { api, errorText, type ViewerState } from './api.ts';
import {
  AgentStatus,
  ConversationSidebar,
  Icon,
  QuestionForm,
  TitleForm,
  type QuestionDraft,
} from './conversations.tsx';
import { locateQuote, quoteRange, selectionText, excludedSelection } from './selection.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { useResizablePanel } from '@plannotator/ui/hooks/useResizablePanel';
import { ResizeHandle } from '@plannotator/ui/components/ResizeHandle';
import { onCodeHighlightSwap } from '@plannotator/ui/utils/codeHighlight';

type Content = { html: string; markdown: string; version: string };

// Placement adapted from Plannotator's CommentPopover (MIT); see THIRD_PARTY_NOTICES.md.
function usePosition(
  ref: RefObject<HTMLElement | null>,
  anchor: (() => DOMRect | undefined) | null,
  width: number,
  preferAbove = false,
) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !anchor) return;
    const update = () => {
      const rect = anchor();
      if (!rect) return;
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8,
        topEdge = (viewport?.offsetTop ?? 0) + 8;
      const rightEdge = leftEdge + (viewport?.width ?? innerWidth) - 16,
        bottomEdge = topEdge + (viewport?.height ?? innerHeight) - 16;
      const size = Math.min(width, rightEdge - leftEdge);
      node.style.width = `${size}px`;
      node.style.maxHeight = `${bottomEdge - topEdge}px`;
      const height = node.offsetHeight;
      const gap = preferAbove ? 10 : 8;
      const below = bottomEdge - rect.bottom - gap,
        above = rect.top - topEdge - gap;
      const placeAbove = preferAbove ? above >= height || above > below : below < height && above > below;
      const top = placeAbove ? rect.top - height - gap : rect.bottom + gap;
      node.style.left = `${Math.max(leftEdge, Math.min(rect.left + rect.width / 2 - size / 2, rightEdge - size))}px`;
      node.dataset.placement = placeAbove ? 'above' : 'below';
      node.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height))}px`;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    // Sidebar resizing changes the passage position without resizing the window.
    const canvas = document.querySelector('.canvas');
    if (canvas) observer.observe(canvas);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [ref, anchor, width, preferAbove]);
}

function App() {
  const [state, setState] = useState<ViewerState | null>(null),
    [content, setContent] = useState<Content>({ html: '', markdown: '', version: '' });
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(''),
    [documentError, setDocumentError] = useState('');
  const [selection, setSelection] = useState<Quote>(),
    [composing, setComposing] = useState(false);
  const [choices, setChoices] = useState<{ ids: string[]; rect: DOMRect } | null>(null);
  const article = useRef<HTMLElement>(null),
    composer = useRef<HTMLElement>(null),
    toolbar = useRef<HTMLDivElement>(null);
  const painted = useRef(new Map<string, string>());
  const highlighter = useRef<Highlighter | null>(null),
    lastRect = useRef<DOMRect>(new DOMRect());
  const ignoreClick = useRef(false),
    pendingFocus = useRef<string | null>(null),
    sendingComment = useRef(false);
  const passageDrafts = useRef(new Map<string, QuestionDraft>());
  const draftKey = JSON.stringify(selection);
  const requestedDocument = new URL(location.href).searchParams.get('document');
  const documentId = requestedDocument ?? Object.keys(state?.documents ?? {})[0] ?? '';
  const current = state?.documents[documentId];
  const threads = Object.values(state?.threads ?? {}).filter((thread) => thread.documentId === documentId);
  const [activeThreadId, setActiveThreadId] = useState<string | null | undefined>(undefined);
  const [isSidebarShown, setSidebarShown] = useState(() => innerWidth > 850);
  const panelResize = useResizablePanel({
    storageKey: 'sidecar-panel-width',
    defaultWidth: innerWidth >= 1500 ? 410 : 365,
    onSnapClose: () => setSidebarShown(false),
    onClick: () => setSidebarShown(false),
    apply: (width) => document.documentElement.style.setProperty('--sidecar-panel-width', `${width}px`),
  });
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidecar-panel-width', `${panelResize.width}px`);
  }, [panelResize.width]);
  const openThread = useCallback(
    (id: string | null) => {
      setActiveThreadId(id);
      setSidebarShown(true);
      if (id) requestAnimationFrame(() => document.getElementById('conversation-back')?.focus({ preventScroll: true }));
      try {
        sessionStorage.setItem(`sidecar-thread:${documentId}`, id ?? 'list');
      } catch {
        /* Private browsing may disable storage. */
      }
    },
    [documentId],
  );
  useEffect(() => {
    if (!current || activeThreadId !== undefined) return;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(`sidecar-thread:${documentId}`);
    } catch {
      /* Selection is still kept in memory. */
    }
    setActiveThreadId(
      saved === 'list'
        ? null
        : (threads.find((thread) => thread.id === saved)?.id ??
            threads.find((thread) => thread.scope === 'document' && !thread.isResolved)?.id ??
            null),
    );
  }, [current, activeThreadId, documentId, threads]);
  useEffect(() => {
    if (activeThreadId === undefined || !documentId) return;
    try {
      sessionStorage.setItem(`sidecar-thread:${documentId}`, activeThreadId ?? 'list');
    } catch {
      /* In-memory selection still works. */
    }
  }, [activeThreadId, documentId]);
  const clearSelection = useCallback(() => {
    // Plannotator's handleToolbarClose removes only the pending source, before
    // the browser starts its next gesture. Keep saved highlight nodes in place.
    highlighter.current?.remove('selection');
    painted.current.delete('selection');
    setSelection(undefined);
    setComposing(false);
    setChoices(null);
  }, []);
  const openComment = useCallback(() => {
    setComposing(true);
    window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    let stopped = false,
      refreshing = false,
      again = false,
      version = '';
    async function refresh() {
      if (refreshing) {
        again = true;
        return;
      }
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
          document.title = doc.title;
          setDocumentError(doc.error ?? '');
          if (!version || (doc.version && version !== doc.version)) {
            try {
              const data = await api<Content>(`/api/documents/${id}`);
              if (stopped) return;
              version = data.version;
              setContent(data);
              setDocumentError('');
            } catch (reason) {
              if (!stopped) setDocumentError(errorText(reason));
            }
          }
        } while (again && !stopped);
      } catch (reason) {
        if (!stopped) setError(errorText(reason));
      } finally {
        refreshing = false;
      }
    }
    const events = new EventSource('/api/events');
    events.onopen = () => {
      setConnected(true);
      void refresh();
    };
    events.onerror = () => setConnected(false);
    events.addEventListener('change', () => {
      void refresh();
    });
    void refresh();
    return () => {
      stopped = true;
      events.close();
    };
  }, [requestedDocument]);

  const [documentText, setDocumentText] = useState('');
  const [highlightRevision, setHighlightRevision] = useState(0);
  useLayoutEffect(() => {
    const root = article.current;
    if (!root) return;
    const refresh = () => setDocumentText(selectionText(root));
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [content.version]);
  useLayoutEffect(
    () =>
      onCodeHighlightSwap((element) => {
        if (!article.current?.contains(element)) return;
        highlighter.current?.removeAll();
        painted.current.clear();
        setHighlightRevision((version) => version + 1);
      }),
    [],
  );
  const anchors = JSON.stringify(
    threads.filter((thread) => thread.quote && !thread.isResolved).map(({ id, quote }) => ({ id, quote })),
  );
  useLayoutEffect(() => {
    const root = article.current;
    if (!root) return;
    const painter = new Highlighter({
      $root: root,
      wrapTag: 'mark',
      exceptSelectors: [excludedSelection],
      style: { className: 'annotation-highlight' },
    });
    highlighter.current = painter;
    painted.current.clear();
    return () => {
      painter.dispose();
      highlighter.current = null;
    };
  }, [content.version]);
  useLayoutEffect(() => {
    const root = article.current,
      painter = highlighter.current;
    if (!root || !painter) return;
    let paintingId = '';
    const releaseId = painter.hooks.Render.UUID.tap(() => paintingId);
    const targets: { id: string; quote?: Quote }[] = documentError ? [] : JSON.parse(anchors);
    if (selection && !documentError) targets.push({ id: 'selection', quote: selection });
    const desired = new Map(targets.map((target) => [target.id, JSON.stringify(target.quote)]));
    for (const [id, quote] of painted.current) {
      if (desired.get(id) !== quote) {
        painter.remove(id);
        painted.current.delete(id);
      }
    }
    for (const target of targets) {
      if (!target.quote || painted.current.has(target.id)) continue;
      const range = quoteRange(root, target.quote);
      if (!range) continue;
      paintingId = target.id;
      painter.fromRange(range);
      painted.current.set(target.id, JSON.stringify(target.quote));
    }
    releaseId();
    for (const mark of painter.getDoms()) {
      const ids = [painter.getIdByDom(mark), ...painter.getExtraIdByDom(mark)];
      mark.toggleAttribute('data-pending', ids.includes('selection'));
      mark.removeAttribute('tabindex');
      mark.removeAttribute('role');
      mark.removeAttribute('title');
      const saved = targets.filter((target) => target.id !== 'selection' && ids.includes(target.id));
      if (saved.length) {
        mark.tabIndex = 0;
        mark.setAttribute('role', 'button');
        mark.title = 'Open passage thread';
      }
    }
  }, [content.version, anchors, selection, documentError, highlightRevision, documentText]);

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (
        ignoreClick.current ||
        (event.target instanceof Node &&
          (toolbar.current?.contains(event.target) || composer.current?.contains(event.target)))
      )
        return;
      if (composing && (sendingComment.current || passageDrafts.current.get(draftKey)?.text.trim())) return;
      const range = window.getSelection();
      if (!range || range.isCollapsed || !article.current?.contains(range.anchorNode)) {
        if (composing) passageDrafts.current.delete(draftKey);
        clearSelection();
      }
    };
    document.addEventListener('mouseup', outside);
    return () => document.removeEventListener('mouseup', outside);
  }, [composing, draftKey, clearSelection]);
  // Use Plannotator's editable-target guards; C only acts while the selection toolbar is open.
  useEffect(() => {
    if (!selection || composing || choices) return;
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.key.toLowerCase() !== 'c'
      )
        return;
      if (
        [event.target, document.activeElement].some(
          (node) =>
            node instanceof Element &&
            node.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])'),
        )
      )
        return;
      event.preventDefault();
      openComment();
    };
    // Copied from Viewer's native copy handler: the highlighter owns the
    // visible selection after mouseup, so supply its captured text to Cmd/Ctrl+C.
    const copy = (event: ClipboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
      )
        return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', selection.exact);
    };
    window.addEventListener('keydown', shortcut);
    document.addEventListener('copy', copy);
    return () => {
      window.removeEventListener('keydown', shortcut);
      document.removeEventListener('copy', copy);
    };
  }, [selection, composing, choices, openComment]);
  // Plannotator dismisses the quick menu and pending highlight on an outside press.
  useEffect(() => {
    if (!selection || composing) return;
    const outside = (event: MouseEvent) => {
      // Preserve double/triple-click selection gestures before removing highlight nodes.
      if (event.detail >= 2) return;
      if (!(event.target instanceof Node) || toolbar.current?.contains(event.target)) return;
      // A press on document text may begin an overlapping drag. Keep its text
      // nodes alive until mouseup captures the new range (or dismisses a click).
      if (article.current?.contains(event.target)) return;
      clearSelection();
      const selected = window.getSelection();
      if (article.current?.contains(selected?.anchorNode ?? null)) selected?.removeAllRanges();
    };
    document.addEventListener('mousedown', outside, true);
    return () => document.removeEventListener('mousedown', outside, true);
  }, [selection, composing, clearSelection]);
  // Like Plannotator, dismiss an empty composer without stealing the clicked target's focus.
  useEffect(() => {
    if (!composing) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || composer.current?.contains(event.target)) return;
      if (article.current?.contains(event.target)) return;
      if (sendingComment.current || passageDrafts.current.get(draftKey)?.text.trim()) return;
      passageDrafts.current.delete(draftKey);
      clearSelection();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [composing, draftKey, clearSelection]);
  useLayoutEffect(() => {
    if (pendingFocus.current && threads.some((thread) => thread.id === pendingFocus.current)) {
      openThread(pendingFocus.current);
      pendingFocus.current = null;
    }
  }, [threads, openThread]);
  const anchor = useCallback(() => {
    if (choices) return highlighter.current?.getDoms(choices.ids[0])[0]?.getBoundingClientRect() ?? choices.rect;
    const root = article.current;
    const range = root && selection && quoteRange(root, selection);
    if (range) lastRect.current = range.getBoundingClientRect();
    return lastRect.current;
  }, [selection, choices]);
  usePosition(composer, composing ? anchor : null, 384);
  usePosition(toolbar, (selection && !composing) || choices ? anchor : null, choices ? 300 : 76, !choices);

  function captureSelection() {
    if (sendingComment.current) return;
    const selected = window.getSelection(),
      root = article.current;
    if (!root || !selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    if ([range.startContainer, range.endContainer].some((node) => node.parentElement?.closest(excludedSelection)))
      return;
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const start = selectionText(before.cloneContents()).length;
    before.setEnd(range.endContainer, range.endOffset);
    const end = selectionText(before.cloneContents()).length;
    const text = selectionText(root),
      exact = text.slice(start, end);
    if (!exact.trim()) {
      clearSelection();
      return;
    }
    lastRect.current = range.getBoundingClientRect();
    // As in web-highlighter's pointer-end handler, the painted mark owns the
    // preview; a native selection left here makes the next drag move text.
    selected.removeAllRanges();
    ignoreClick.current = true;
    requestAnimationFrame(() => {
      ignoreClick.current = false;
    });
    setSelection({
      exact,
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(end, end + 32),
      start,
      end,
      version: content.version,
    });
    setComposing(false);
    setChoices(null);
  }
  function visitHighlight(target: EventTarget | null) {
    if (ignoreClick.current || sendingComment.current || !(target instanceof Element)) return;
    const mark = target.closest('mark'),
      painter = highlighter.current;
    if (!mark || !painter) return;
    const ids = [...new Set([painter.getIdByDom(mark), ...painter.getExtraIdByDom(mark)])].filter((id) =>
      threads.some((thread) => thread.id === id),
    );
    if (ids.length) setSidebarShown(true);
    if (ids.length === 1) {
      clearSelection();
      openThread(ids[0]);
    } else if (ids.length > 1) {
      setComposing(false);
      setSelection(undefined);
      setChoices({ ids, rect: mark.getBoundingClientRect() });
    }
    return ids.length > 0;
  }
  const passageChanged = (quote: Quote) => !!documentError || !locateQuote(documentText, quote);
  const cancel = () => {
    if (!sendingComment.current) {
      clearSelection();
      article.current?.focus({ preventScroll: true });
    }
  };
  const sent = (request: RequestRecord) => {
    clearSelection();
    pendingFocus.current = request.threadId;
    openThread(request.threadId);
  };
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <Icon name="logo" />
          Sidecar
        </div>
        <span className="separator" />
        {current && <TitleForm key={documentId} id={documentId} title={current.title} />}
        {Object.keys(state?.documents ?? {}).length > 1 && (
          <select
            className="document-picker"
            aria-label="Documents"
            value={documentId}
            onChange={(event) => {
              location.href = `/?document=${event.target.value}`;
            }}
          >
            {Object.values(state?.documents ?? {}).map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.title}
              </option>
            ))}
          </select>
        )}
        <AgentStatus state={state} connected={connected} />
        <button
          className="sidebar-toggle"
          aria-label={isSidebarShown ? 'Hide conversations' : 'Show conversations'}
          title={isSidebarShown ? 'Hide conversations' : 'Show conversations'}
          aria-expanded={isSidebarShown}
          aria-controls="conversation-sidebar"
          onClick={() => setSidebarShown((shown) => !shown)}
        >
          <Icon name="panel" />
        </button>
      </header>
      {error && (
        <p className="app-error" role="alert">
          {error}
        </p>
      )}
      <div className={`layout${isSidebarShown ? '' : ' sidebar-collapsed'}`}>
        <main className="canvas">
          <div className="reading-width">
            {(documentError || !current) && (
              <p data-testid="document-error" role="alert">
                {documentError || 'Open a document from your agent.'}
              </p>
            )}
            <article
              className="document-card w-full bg-card rounded-xl p-5 md:p-8 lg:p-10 xl:p-12 shadow-xl border border-border/50"
              id="document"
              ref={article}
              tabIndex={-1}
              aria-label="Document"
              key={content.version}
              onMouseUp={captureSelection}
              onTouchEnd={captureSelection}
              onClick={(event) => {
                if (visitHighlight(event.target)) event.preventDefault();
              }}
              onKeyUp={(event) => {
                if (event.key.startsWith('Arrow') || event.key === 'Shift') captureSelection();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') cancel();
                if (
                  event.target instanceof HTMLElement &&
                  event.target.matches('mark') &&
                  ['Enter', ' '].includes(event.key)
                ) {
                  event.preventDefault();
                  visitHighlight(event.target);
                }
              }}
            >
              <MarkdownDocument markdown={content.markdown} documentId={documentId} />
            </article>
          </div>
        </main>
        {isSidebarShown && (
          <ResizeHandle
            {...panelResize.handleProps}
            className="sidebar-resize"
            side="right"
            hideHoverTrack
            tooltip="Drag to resize · Click to collapse"
            onCollapse={() => setSidebarShown(false)}
          />
        )}
        <ConversationSidebar
          documentId={documentId}
          threads={threads}
          activeId={activeThreadId ?? null}
          onOpen={openThread}
          onCreated={(thread) =>
            setState((previous) =>
              previous && !previous.threads[thread.id]
                ? { ...previous, threads: { ...previous.threads, [thread.id]: thread } }
                : previous,
            )
          }
          requests={Object.values(state?.requests ?? {})}
          stream={state?.stream ?? null}
          passageChanged={passageChanged}
          isShown={isSidebarShown}
          showPassage={(quote) => {
            const root = article.current,
              range = root && quoteRange(root, quote);
            if (!range) return;
            const node = range.startContainer.parentElement;
            node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            if (innerWidth <= 850) setSidebarShown(false);
            (node?.closest('mark') ?? root)?.focus({ preventScroll: true });
          }}
        />
      </div>
      {((selection && !composing) || choices) &&
        createPortal(
          <div
            ref={toolbar}
            key={choices ? 'choices' : draftKey}
            className={`floating selection-actions${choices ? '' : ' annotation-toolbar'}`}
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancel();
            }}
          >
            {choices ? (
              choices.ids.map((id) => (
                <button
                  key={id}
                  onClick={() => {
                    clearSelection();
                    openThread(id);
                  }}
                >
                  {threads.find((thread) => thread.id === id)?.messages[0]?.text ?? 'Open thread'}
                </button>
              ))
            ) : (
              <>
                <button
                  className="comment-action"
                  onClick={openComment}
                  aria-label="Comment"
                  aria-keyshortcuts="c"
                  title="Comment (C)"
                >
                  <Icon name="comment" />
                </button>
                <span className="toolbar-divider" aria-hidden="true" />
                <button onClick={cancel} aria-label="Cancel selection" title="Cancel">
                  <Icon name="close" />
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
      {composing &&
        selection &&
        createPortal(
          <section ref={composer} className="floating comment-popover" role="dialog" aria-label="Comment on selection">
            <QuestionForm
              key={draftKey}
              documentId={documentId}
              quote={selection}
              quoteChanged={passageChanged(selection)}
              disabled={!current}
              floating
              onCancel={cancel}
              onSent={sent}
              drafts={passageDrafts.current}
              draftKey={draftKey}
              onSendingChange={(sending) => {
                sendingComment.current = sending;
              }}
            />
          </section>,
          document.body,
        )}
    </>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
