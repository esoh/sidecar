import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import Highlighter from '@plannotator/web-highlighter';
import type { Quote, RequestRecord, Thread } from '../src/store.ts';
import { api, errorText, mergeRuntime, type ViewerState, type ViewerRuntime, type ClosedDocument } from './api.ts';
import { randomId } from './id.ts';
import { confirmCloseDocument } from './close-document.ts';
import {
  AgentStatus,
  ConversationSidebar,
  Icon,
  QuestionForm,
  TitleForm,
} from './conversations.tsx';
import { useQuestionDrafts, forgetDocument, type QuestionDraft, type QuestionDrafts } from './useQuestionDrafts.ts';
import { quoteIssue, quoteRange, selectionText, selectionSentence, excludedSelection } from './selection.ts';
import { revealRange } from './reveal-target.ts';
import { MarkdownDocument, WorkspaceLinks, type OpenWorkspaceLink } from './MarkdownDocument.tsx';
import { resolveWorkspaceLink, splitLineSuffix } from './links.ts';
import { setDocPreviewFetcher } from '@plannotator/ui/components/InlineMarkdown';
import { DocumentLibrary } from './DocumentLibrary.tsx';
import { SettingsProvider, TextSettings } from './TextSettings.tsx';
import { PinnedWindows } from './PinnedWindows.tsx';
import { DocumentHeader } from './DocumentHeader.tsx';
import { OriginalDocument } from './OriginalDocument.tsx';
import { FilesPanel } from './FilesPanel.tsx';
import { isAnnotatableDocPath } from '@plannotator/core/annotatable';
import type { OpenFile } from './FilePreview.tsx';
import type { FileQuote } from '../src/quote.ts';
import { useResizablePanel } from '@plannotator/ui/hooks/useResizablePanel';
import { ResizeHandle } from '@plannotator/ui/components/ResizeHandle';
import { onCodeHighlightSwap } from '@plannotator/ui/utils/codeHighlight';
import { usePosition } from './usePosition.ts';
import { messagePreview } from './message-copy.ts';
import { ProposalReviewContext, useProposalReview } from './ProposalReview.tsx';

type Content = { html: string; markdown: string; version: string };
const insideRoot = (path: string, root: string) => path.startsWith(`${root.replace(/\/$/, '')}/`);

function keepsAttachment(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('.sidebar .composer, .sidebar-header, .thread-row, .sidebar-toggle, .files-edge-toggle, .files-panel, .file-preview');
}

function App() {
  const [state, setState] = useState<ViewerState | null>(null),
    [content, setContent] = useState<Content>({ html: '', markdown: '', version: '' });
  const [closedDocument, setClosedDocument] = useState<ClosedDocument | null>(null),
    [isClosing, setClosing] = useState(false);
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(''),
    [documentError, setDocumentError] = useState('');
  const [selection, setSelection] = useState<Quote>(),
    [composing, setComposing] = useState(false);
  const [choices, setChoices] = useState<{ ids: string[]; rect: DOMRect } | null>(null);
  const article = useRef<HTMLElement>(null),
    workspace = useRef<HTMLDivElement>(null),
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
  const drafts = useQuestionDrafts(documentId);
  const floatingDrafts = useMemo<QuestionDrafts>(() => ({
    get: id => passageDrafts.current.get(id),
    set: (id, draft) => { passageDrafts.current.set(id, draft); },
    remove: (id, expected) => { if (!expected || passageDrafts.current.get(id) === expected) passageDrafts.current.delete(id); },
    flush: () => {}, error: '',
  }), []);
  useEffect(() => {
    if (current) void api(`/api/documents/${documentId}/opened`, {}).catch(reason => setError(errorText(reason)));
  }, [documentId, !!current]);
  const threads = Object.values(state?.threads ?? {}).filter((thread) => thread.documentId === documentId);
  const [activeThreadId, setActiveThreadId] = useState<string | null | undefined>(undefined);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [sentRequestId, setSentRequestId] = useState<string | null>(null);
  const [messageVisit, setMessageVisit] = useState(0);
  const [openPins, setOpenPins] = useState<string[]>([]);
  const [messageJump, setMessageJump] = useState<{ id: string; sequence: number } | null>(null);
  const [originalMessageId, setOriginalMessageId] = useState<string | null>(null);
  const selectedMessages = threads.flatMap(thread => thread.messages.flatMap(message => (message.selections ?? []).map(selection => ({ thread, message, selection }))));
  const originalMessage = selectedMessages.find(({ thread, selection }) => thread.id === activeThreadId && selection.id === originalMessageId)?.selection;
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
  const [isFilesShown, setFilesShown] = useState(() => {
    try { return localStorage.getItem('sidecar-files-open') === 'true'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('sidecar-files-open', String(isFilesShown)); } catch { /* per-browser convenience only */ }
  }, [isFilesShown]);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [visibleRoot, setVisibleRoot] = useState<string | null>(null);
  const [fileReveal, setFileReveal] = useState<{ path: string; id: number } | null>(null);
  const rootVisit = useRef(0);
  useEffect(() => { rootVisit.current++; setVisibleRoot(null); setFileReveal(null); }, [documentId, current?.workspace]);
  const browserRoot = visibleRoot ?? current?.workspace;
  const [files, setFiles] = useState<OpenFile[]>([]);
  const fileThread = useRef<Promise<Thread> | null>(null);
  const fileSelectionVisit = useRef(0);
  useEffect(() => { fileThread.current = null; }, [activeThreadId]);
  const filesResize = useResizablePanel({
    storageKey: 'sidecar-files-width',
    defaultWidth: 280,
    side: 'left',
    onSnapClose: () => setFilesShown(false),
    onClick: () => setFilesShown(false),
    apply: (width) => document.documentElement.style.setProperty('--sidecar-files-width', `${width}px`),
  });
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidecar-files-width', `${filesResize.width}px`);
  }, [filesResize.width]);
  const openThread = useCallback(
    (id: string | null) => {
      fileSelectionVisit.current++;
      const focusBeforeOpen = document.activeElement;
      setOriginalMessageId(null);
      drafts.flush();
      setSelection(id ? drafts.get(id)?.quote : undefined);
      setComposing(false);
      setChoices(null);
      setActiveThreadId(id);
      setActiveMessageId(null);
      setSidebarShown(true);
      if (id) requestAnimationFrame(() => {
        if (document.activeElement === focusBeforeOpen) document.getElementById('conversation-back')?.focus({ preventScroll: true });
      });
      try {
        sessionStorage.setItem(`sidecar-thread:${documentId}`, id ?? 'list');
      } catch {
        /* Private browsing may disable storage. */
      }
    },
    [documentId, drafts],
  );
  function goToMessage(id: string) {
    const thread = threads.find(thread => thread.messages.some(message => message.id === id));
    if (!thread) return;
    openThread(thread.id);
    setMessageJump(previous => ({ id, sequence: (previous?.sequence ?? 0) + 1 }));
  }
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
            threads.find((thread) => !thread.isResolved)?.id ??
            null),
    );
  }, [current, activeThreadId, documentId, threads]);
  useEffect(() => {
    if (closedDocument || activeThreadId === undefined || !documentId) return;
    try {
      sessionStorage.setItem(`sidecar-thread:${documentId}`, activeThreadId ?? 'list');
    } catch {
      /* In-memory selection still works. */
    }
  }, [activeThreadId, documentId, closedDocument]);
  const pendingQuote = activeThreadId ? drafts.get(activeThreadId)?.quote : undefined;
  useEffect(() => {
    if (!composing && isSidebarShown && activeThreadId) setSelection(pendingQuote);
  }, [activeThreadId, pendingQuote, composing, isSidebarShown]);
  useEffect(() => {
    if (activeMessageId && selectedMessages.some(({ thread, selection }) => thread.id === activeThreadId && selection.id === activeMessageId)) return;
    setActiveMessageId(selectedMessages.filter(({ thread }) => thread.id === activeThreadId).at(-1)?.selection.id ?? null);
  }, [activeThreadId, activeMessageId, selectedMessages.map(({ selection }) => selection.id).join(',')]);
  useEffect(() => {
    if (!sentRequestId) return;
    const thread = threads.find(thread => thread.messages.some(message => message.role === 'user' && message.requestId === sentRequestId));
    const message = thread?.messages.find(message => message.role === 'user' && message.requestId === sentRequestId);
    if (message) {
      if (thread?.id === activeThreadId && message.selections?.[0]) setActiveMessageId(message.selections[0].id);
      setSentRequestId(null);
    }
  }, [sentRequestId, state, activeThreadId]);
  const removeAttachment = useCallback(() => {
    if (!activeThreadId) return;
    const draft = drafts.get(activeThreadId);
    if (draft?.quote || draft?.messageQuote || draft?.fileQuote) { const { quote, messageQuote, fileQuote, ...rest } = draft; drafts.set(activeThreadId, rest); }
  }, [activeThreadId, drafts]);
  const clearPendingSelection = useCallback(() => {
    // Plannotator's handleToolbarClose removes only the pending source, before
    // the browser starts its next gesture. Keep saved highlight nodes in place.
    highlighter.current?.remove('selection');
    painted.current.delete('selection');
    setSelection(undefined);
    setComposing(false);
    setChoices(null);
  }, []);
  const openPreview = useCallback((path: string, refusal?: string, kind: OpenFile['kind'] = 'doc', root = current?.workspace) => {
    // Keep passage drafts; file windows cannot attach selections to the main document.
    clearPendingSelection();
    window.getSelection()?.removeAllRanges();
    const absolutePath = root && !refusal ? `${root.replace(/\/$/, '')}/${path}` : path;
    setPreviewPath(absolutePath);
    const id = `file:${absolutePath}`;
    setFiles(previous => {
      const existing = previous.find(file => file.id === id);
      const file = { id, path, root, kind, refusal, revision: (existing?.revision ?? 0) + 1 };
      return existing ? previous.map(value => value.id === id ? file : value) : [...previous, file];
    });
    setOpenPins(previous => [...previous, id]);
    if (innerWidth <= 850) setFilesShown(false);
  }, [clearPendingSelection, current?.workspace]);
  const allowRoot = useCallback(async (directory: string) => {
    if (directory === current?.workspace) return directory;
    return (await api<{ root: string }>('/api/files/root', { documentId, directory })).root;
  }, [documentId, current?.workspace]);
  const changeVisibleRoot = useCallback(async (directory: string, revealPath?: string) => {
    const visit = ++rootVisit.current;
    try {
      const root = await allowRoot(directory);
      if (visit !== rootVisit.current) return;
      setVisibleRoot(root); setFilesShown(true);
      if (revealPath) { setPreviewPath(revealPath); setFileReveal(previous => ({ path: revealPath, id: (previous?.id ?? 0) + 1 })); }
      else setFileReveal(null);
    } catch (reason) { if (visit === rootVisit.current) setError(errorText(reason)); }
  }, [allowRoot]);
  function revealFile(path: string) {
    const root = browserRoot && insideRoot(path, browserRoot) ? browserRoot : path.slice(0, path.lastIndexOf('/')) || '/';
    void changeVisibleRoot(root, path);
  }
  const openAbsoluteFile = useCallback(async (absolutePath: string, kind?: OpenFile['kind']) => {
    const path = absolutePath.replace(/^\/\/+/, '/');
    const sourceRoot = browserRoot && insideRoot(path, browserRoot) ? browserRoot
      : current?.workspace && insideRoot(path, current.workspace) ? current.workspace : path.slice(0, path.lastIndexOf('/')) || '/';
    try {
      const root = await allowRoot(sourceRoot);
      openPreview(path.slice(sourceRoot.replace(/\/$/, '').length + 1), undefined, kind ?? (isAnnotatableDocPath(path) ? 'doc' : 'code'), root);
    } catch (reason) { setError(errorText(reason)); }
  }, [browserRoot, current?.workspace, allowRoot, openPreview]);
  const workspaceRoot = useRef<string | undefined>(undefined);
  workspaceRoot.current = current?.workspace;
  const resolveLink = (kind: 'doc' | 'code', target: string, baseDir?: string) => {
    const root = workspaceRoot.current;
    if (!root) return null;
    // Repository-style code paths (src/app.ts:4) are workspace-relative; ./ and ../ follow the linking file.
    return resolveWorkspaceLink(target, root, kind === 'code' && !/^\.\.?\//.test(target) ? root : baseDir ?? root);
  };
  const handleLink = useRef<OpenWorkspaceLink>(() => undefined);
  handleLink.current = (kind, target, baseDir) => {
    const [file] = kind === 'code' ? splitLineSuffix(target) : [target];
    const resolved = resolveLink(kind, file, baseDir);
    if (!resolved) openPreview(file, 'This document has no recorded workspace. Reopen it from your agent.');
    else void openAbsoluteFile('outside' in resolved ? resolved.outside : `${workspaceRoot.current}/${resolved.path}`, kind);
  };
  // Stable identity so memoized documents and messages do not re-render on every state tick.
  const openLink = useCallback<OpenWorkspaceLink>((...args) => handleLink.current(...args), []);
  useEffect(() => {
    // Plannotator's hover preview for `path:line` code references reads Sidecar's code route.
    setDocPreviewFetcher(async (candidate) => {
      const [file, line] = splitLineSuffix(candidate);
      const resolved = resolveLink('code', file);
      if (!resolved || 'outside' in resolved) return null;
      const response = await fetch(`/api/files/code?document=${encodeURIComponent(documentId)}&path=${encodeURIComponent(resolved.path + line)}`);
      if (!response.ok) return null;
      const data = await response.json() as { contents: string; filepath: string };
      return { contents: data.contents, filepath: data.filepath };
    });
  }, [documentId]);
  const clearSelection = useCallback(() => {
    fileSelectionVisit.current++;
    removeAttachment();
    clearPendingSelection();
  }, [removeAttachment, clearPendingSelection]);
  const openComment = useCallback(() => {
    removeAttachment();
    setComposing(true);
    window.getSelection()?.removeAllRanges();
  }, [removeAttachment]);

  const documentClosed = useCallback((result: ClosedDocument) => {
    const storageError = forgetDocument(result.documentId, result.threadIds);
    if (result.documentId === documentId) {
      passageDrafts.current.clear();
      setClosedDocument({ ...result, cleanupError: result.cleanupError ?? storageError });
      setContent({ html: '', markdown: '', version: '' });
      setSelection(undefined);
      setComposing(false);
      setChoices(null);
      setError('');
      document.title = 'Document closed — Sidecar';
    }
  }, [documentId]);
  useEffect(() => {
    if (closedDocument) return;
    let stopped = false,
      refreshing = false,
      again = false,
      version = '',
      connectionGeneration = 0,
      snapshotGeneration = 0;
    let latestRuntime: ViewerRuntime | undefined;
    async function refresh() {
      if (refreshing) {
        again = true;
        return;
      }
      refreshing = true;
      try {
        do {
          again = false;
          const generation = connectionGeneration;
          const next = await api<ViewerState>('/api/state');
          if (stopped) return;
          if (generation !== connectionGeneration) { again = true; continue; }
          // A slow history response must not rewind newer text/status received over SSE.
          if (!latestRuntime || next.runtimeRevision >= latestRuntime.runtimeRevision) {
            const { stateRevision, runtimeRevision, stream, activity, reset, connectionError } = next;
            latestRuntime = { stateRevision, runtimeRevision, stream, activity, reset, connectionError };
          }
          const runtime = latestRuntime, hadSnapshot = snapshotGeneration === generation;
          snapshotGeneration = generation;
          setState(current => mergeRuntime(
            hadSnapshot && current && current.runtimeRevision > next.runtimeRevision ? { ...next, stream: current.stream } : next,
            runtime,
          ));
          const id = requestedDocument ?? Object.keys(next.documents)[0] ?? '';
          const doc = next.documents[id];
          if (!doc) { setContent({ html: '', markdown: '', version: '' }); continue; }
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
    const events = new EventSource('/api/events?updates=1');
    events.onopen = () => {
      // Revisions belong to one server lifetime; a reconnect may follow an upgrade.
      connectionGeneration++; latestRuntime = undefined;
      setConnected(true);
      void refresh();
    };
    events.onerror = () => setConnected(false);
    events.addEventListener('runtime', (event) => {
      const runtime: ViewerRuntime = JSON.parse(event.data);
      if (stopped || (latestRuntime && runtime.runtimeRevision < latestRuntime.runtimeRevision)) return;
      latestRuntime = runtime;
      // Keep live text until its saved progress/final replacement is in history.
      setState(current => current ? mergeRuntime(current, runtime) : current);
    });
    events.addEventListener('change', () => {
      void refresh();
    });
    events.addEventListener('document-closed', (event) => {
      const result: ClosedDocument = JSON.parse(event.data);
      if (result.documentId === documentId) { stopped = true; events.close(); }
      documentClosed(result);
    });
    return () => {
      stopped = true;
      events.close();
    };
  }, [requestedDocument, documentClosed, closedDocument]);

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
    selectedMessages.filter(({ selection }) => selection.isVisible).map(({ selection }) => ({ id: selection.id, quote: selection.quote })),
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
      // Exact overlaps leave empty text nodes inside the library's marks. A later
      // partial overlap detaches those nodes while wrapping; normalize only marks.
      for (const mark of painter.getDoms()) mark.normalize();
      const range = quoteRange(root, target.quote, content.version);
      if (!range) continue;
      paintingId = target.id;
      painter.fromRange(range);
      painted.current.set(target.id, JSON.stringify(target.quote));
    }
    releaseId();
    for (const mark of painter.getDoms()) {
      const ids = [painter.getIdByDom(mark), ...painter.getExtraIdByDom(mark)];
      mark.toggleAttribute('data-pending', ids.includes('selection'));
      mark.toggleAttribute('data-active', !!activeMessageId && ids.includes(activeMessageId));
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
  }, [content.version, anchors, selection, documentError, highlightRevision, documentText, activeMessageId]);

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (
        ignoreClick.current || keepsAttachment(event.target) ||
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
        window.getSelection()?.anchorNode?.parentElement?.closest('.file-preview') ||
        [event.target, document.activeElement].some(
          (node) =>
            node instanceof Element &&
            node.closest('.file-preview, input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])'),
        )
      )
        return;
      event.preventDefault();
      openComment();
    };
    // Copied from Viewer's native copy handler: the highlighter owns the
    // visible selection after mouseup, so supply its captured text to Cmd/Ctrl+C.
    const copy = (event: ClipboardEvent) => {
      const nativeSelection = window.getSelection();
      if (nativeSelection && !nativeSelection.isCollapsed && !article.current?.contains(nativeSelection.anchorNode)) return;
      if (
        event.target instanceof Element &&
        event.target.closest('.file-preview, input, textarea, [contenteditable]:not([contenteditable="false"])')
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
      if (!(event.target instanceof Node) || toolbar.current?.contains(event.target) || keepsAttachment(event.target)) return;
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
      if (!(event.target instanceof Node) || composer.current?.contains(event.target) || keepsAttachment(event.target)) return;
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
    const range = root && selection && quoteRange(root, selection, content.version);
    if (range) lastRect.current = range.getBoundingClientRect();
    return lastRect.current;
  }, [selection, choices, content.version]);
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
    revealRange(range);
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
    const sentence = selectionSentence(range);
    lastRect.current = range.getBoundingClientRect();
    // As in web-highlighter's pointer-end handler, the painted mark owns the
    // preview; a native selection left here makes the next drag move text.
    selected.removeAllRanges();
    ignoreClick.current = true;
    requestAnimationFrame(() => {
      ignoreClick.current = false;
    });
    const quote: Quote = {
      exact,
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(end, end + 32),
      start,
      end,
      version: content.version,
      isPositionVerified: true,
      ...(sentence ? { sentence } : {}),
    };
    fileSelectionVisit.current++;
    setSelection(quote);
    if (activeThreadId && isSidebarShown) {
      const draft = drafts.get(activeThreadId) ?? { text: '', retry: null };
      const { messageQuote, fileQuote, ...rest } = draft;
      drafts.set(activeThreadId, { ...rest, quote });
    }
    setComposing(false);
    setChoices(null);
  }
  function openMessage(id: string) {
    const selected = selectedMessages.find(({ selection }) => selection.id === id);
    if (!selected) return;
    openThread(selected.thread.id);
    setActiveMessageId(id);
    setMessageVisit(visit => visit + 1);
  }
  function visitHighlight(target: EventTarget | null) {
    if (ignoreClick.current || sendingComment.current || !(target instanceof Element)) return;
    const mark = target.closest('mark'),
      painter = highlighter.current;
    if (!mark || !painter) return;
    const ids = [...new Set([painter.getIdByDom(mark), ...painter.getExtraIdByDom(mark)])].filter((id) =>
      selectedMessages.some(({ selection }) => selection.id === id),
    );
    if (ids.length) setSidebarShown(true);
    if (ids.length === 1) {
      clearSelection();
      if (!proposalReview.open(ids[0], mark)) openMessage(ids[0]);
    } else if (ids.length > 1) {
      setComposing(false);
      setSelection(undefined);
      setChoices({ ids, rect: mark.getBoundingClientRect() });
    }
    return ids.length > 0;
  }
  const passageIssue = (quote: Quote) => documentError ? 'Document unavailable' : quoteIssue(documentText, quote, content.version);
  async function quoteFile(fileQuote: FileQuote) {
    const visit = ++fileSelectionVisit.current;
    clearPendingSelection();
    ignoreClick.current = true;
    requestAnimationFrame(() => { ignoreClick.current = false; });
    try {
      let target = activeThreadId;
      if (!target) {
        fileThread.current ??= api<Thread>('/api/threads', { id: randomId(), documentId });
        const thread = await fileThread.current;
        setState(previous => previous ? { ...previous, threads: { ...previous.threads, [thread.id]: thread } } : previous);
        target = thread.id;
      }
      if (visit !== fileSelectionVisit.current) return;
      const { quote, messageQuote, ...draft } = drafts.get(target) ?? { text: '', retry: null };
      drafts.set(target, { ...draft, fileQuote });
      if (activeThreadId !== target || !isSidebarShown) openThread(target);
    } catch (reason) { fileThread.current = null; setError(errorText(reason)); }
  }
  const selectionActions = {
    onOpenFileQuote: (quote: FileQuote) => openLink(quote.kind, quote.path),
    onQuoteMessage: (messageQuote: import('../src/quote.ts').MessageQuote) => {
      fileSelectionVisit.current++;
      const target = activeThreadId && isSidebarShown ? activeThreadId : messageQuote.threadId;
      clearPendingSelection();
      const { quote, fileQuote, ...draft } = drafts.get(target) ?? { text: '', retry: null };
      drafts.set(target, { ...draft, messageQuote });
      if (activeThreadId !== target || !isSidebarShown) openThread(target);
      ignoreClick.current = true;
      requestAnimationFrame(() => { ignoreClick.current = false; });
    },
    activeSelectionId: activeMessageId,
    passageIssue,
    showOriginal: (selectionId: string) => {
      const entry = selectedMessages.find(({ selection }) => selection.id === selectionId);
      if (entry) setActiveThreadId(entry.thread.id);
      clearSelection();
      window.getSelection()?.removeAllRanges();
      setOriginalMessageId(selectionId);
      setPreviewPath(null);
      setActiveMessageId(selectionId);
      if (innerWidth <= 850) setSidebarShown(false);
    },
    showPassage: (selection: import('../src/store.ts').MessageSelection) => {
      const entry = selectedMessages.find(item => item.selection.id === selection.id);
      if (entry) setActiveThreadId(entry.thread.id);
      setActiveMessageId(selection.id);
      setOriginalMessageId(null);
      setPreviewPath(null);
      requestAnimationFrame(() => {
        const root = article.current, range = root && quoteRange(root, selection.quote, content.version);
        if (!range) return;
        revealRange(range);
        const node = range.startContainer.parentElement;
        node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (innerWidth <= 850) setSidebarShown(false);
        (node?.closest('mark') ?? root)?.focus({ preventScroll: true });
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          for (const mark of highlighter.current?.getDoms(selection.id) ?? [])
            mark.animate([{ boxShadow: '0 0 0 5px oklch(0.75 0.18 280 / 0.6)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 700 });
        }
      });
    },
  };
  const proposalReview = useProposalReview({
    documentId, proposals: Object.values(state?.proposals ?? {}).filter(p => p.documentId === documentId),
    selections: selectedMessages.map(item => item.selection), article, version: content.version,
    isHistorical: !!originalMessageId || !!previewPath,
    onShowSelection: selectionActions.showPassage, onShowOriginal: selectionActions.showOriginal,
    onReturnToCurrent: () => { setOriginalMessageId(null); setPreviewPath(null); },
  });
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
  async function closeCurrentDocument() {
    if (!current || isClosing) return;
    if (Object.values(state?.requests ?? {}).some(request => request.documentId === documentId && ['queued', 'claimed', 'uncertain'].includes(request.status))) {
      setError('Wait for this document’s pending agent requests to finish before closing it.');
      return;
    }
    if (!confirmCloseDocument(current.title)) return;
    setClosing(true);
    try {
      documentClosed(await api<ClosedDocument>(`/api/documents/${documentId}`, undefined, 'DELETE'));
    } catch (reason) { setError(errorText(reason)); }
    finally { setClosing(false); }
  }
  if (closedDocument) return (
    <>
      <header className="topbar"><div className="brand"><Icon name="logo" />Sidecar</div></header>
      <main className="canvas">
        <div className="reading-width">
          <h1>Document closed</h1>
          <p>Your Markdown file is unchanged.</p>
          {closedDocument.cleanupError && <p role="alert">{closedDocument.cleanupError}</p>}
          <a href="/?library=1">Browse all documents</a>
        </div>
      </main>
    </>
  );
  return (
    <WorkspaceLinks.Provider value={openLink}>
      <ProposalReviewContext.Provider value={proposalReview.context}>
      {proposalReview.popover}
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
        <TextSettings version={state?.appVersion} />
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
        {current && (
          <button className="sidebar-toggle" aria-label="Close document" title="Close document" disabled={isClosing} onClick={() => { void closeCurrentDocument(); }}>
            <Icon name="close" />
          </button>
        )}
      </header>
      {current?.workspace && <button
        className="files-edge-toggle"
        aria-label={isFilesShown ? 'Hide files' : 'Show files'} title={isFilesShown ? 'Hide files' : 'Show files'}
        aria-expanded={isFilesShown} aria-controls="files-panel"
        onClick={() => setFilesShown(shown => !shown)}
      ><Icon name="folder" /></button>}
      {error && (
        <p className="app-error" role="alert">
          {error}
        </p>
      )}
      <div className={`layout${isSidebarShown ? '' : ' sidebar-collapsed'}${isFilesShown && current?.workspace ? ' files-open' : ''}`}>
        {isFilesShown && current?.workspace && (
          <>
            <FilesPanel key={`${documentId}:${browserRoot}`} documentId={documentId} root={browserRoot ?? current.workspace} workspace={current.workspace}
              activePath={previewPath} reveal={fileReveal} onSelect={openAbsoluteFile} onRootChange={changeVisibleRoot} />
            <ResizeHandle
              {...filesResize.handleProps}
              className="files-resize"
              side="left"
              hideHoverTrack
              tooltip="Drag to resize · Click to collapse"
              onCollapse={() => setFilesShown(false)}
            />
          </>
        )}
        <div className="document-workspace" ref={workspace}>
        <main className="canvas">
          <div className="reading-width">
            {originalMessage?.quote && activeThreadId && (
              <OriginalDocument
                key={originalMessage.id}
                documentId={documentId}
                threadId={activeThreadId}
                selectionId={originalMessage.id}
                quote={originalMessage.quote}
                onReturn={() => setOriginalMessageId(null)}
              />
            )}
            {!originalMessage && (documentError || !current) && (
              <p data-testid="document-error" role="alert">
                {documentError || 'Open a document from your agent.'}
              </p>
            )}
            <article
              className="document-card w-full bg-card rounded-xl p-5 md:p-8 lg:p-10 xl:p-12 shadow-xl border border-border/50"
              id="document"
              hidden={!!originalMessage}
              ref={article}
              tabIndex={-1}
              aria-label="Document"
              key={content.version}
              onMouseUp={captureSelection}
              onTouchEnd={captureSelection}
              onClick={(event) => {
                if (ignoreClick.current || visitHighlight(event.target)) event.preventDefault();
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
              {current && !documentError && <DocumentHeader key={documentId} repoInfo={current.repoInfo} markdown={content.markdown} onError={setError} />}
              <MarkdownDocument markdown={content.markdown} documentId={documentId} linkBase={current?.path.replace(/\/[^/]*$/, '')} canCollapseHeadings />
            </article>
          </div>
        </main>
        <PinnedWindows key={documentId} workspace={workspace} threads={threads} files={files} root={current?.workspace} documentId={documentId} onQuoteFile={quoteFile} onRevealFile={revealFile} openRequests={openPins} onOpened={ids => setOpenPins(previous => previous.filter(id => !ids.includes(id)))} onCloseFile={id => {
          setFiles(previous => previous.filter(file => file.id !== id));
          setPreviewPath(previous => `file:${previous}` === id ? null : previous);
        }} {...selectionActions} onGoToMessage={goToMessage} />
        </div>
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
          {...selectionActions}
          isShown={isSidebarShown}
          drafts={drafts}
          onRemoveSelection={clearSelection}
          activeMessageId={selectedMessages.find(({ selection }) => selection.id === activeMessageId)?.message.id ?? null}
          messageVisit={messageVisit}
          onMessageSent={request => setSentRequestId(request.id)}
          onOpenPin={id => setOpenPins(previous => [...previous.filter(value => value !== id), id])}
          onGoToMessage={goToMessage}
          messageJump={messageJump}
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
              choices.ids.map((id) => {
                const entry = selectedMessages.find(({ selection }) => selection.id === id);
                const preview = entry?.selection.label ?? (entry ? messagePreview(entry.message.text) : 'Open message');
                return <button
                  key={id}
                  className="highlight-choice"
                  onClick={(event) => {
                    clearSelection();
                    if (!proposalReview.open(id, event.currentTarget)) openMessage(id);
                  }}
                >
                  <span className="highlight-choice-thread" title={entry?.thread.title ?? 'Unnamed'}>{entry?.thread.title ?? 'Unnamed'}</span>
                  <span className="highlight-choice-preview">{preview.length > 240 ? `${preview.slice(0, 240)}…` : preview}</span>
                </button>;
              })
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
              quoteIssue={passageIssue(selection)}
              disabled={!current}
              floating
              onCancel={cancel}
              onSent={sent}
              drafts={floatingDrafts}
              draftKey={draftKey}
              onSendingChange={(sending) => {
                sendingComment.current = sending;
              }}
            />
          </section>,
          document.body,
        )}
      </ProposalReviewContext.Provider>
    </WorkspaceLinks.Provider>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<SettingsProvider>{new URLSearchParams(location.search).has('library') ? <DocumentLibrary /> : <App />}</SettingsProvider>);
