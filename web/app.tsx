import { viewerPath, isGateway, libraryPath } from './viewer-path.ts';
import { HtmlControls, HtmlFileViewer, htmlFullPageUrl, isHtmlPath, revealParameter, isHtmlViewValid, readHtmlView, useHtmlBridge, type HtmlFile } from './HtmlFile.tsx';
import { ViewerEvents } from './viewer-events.ts';
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
import { resolveWorkspaceLink, splitLineSuffix, fileLineRange, pageLinkTarget, type FileLineRange } from './links.ts';
import { setDocPreviewFetcher } from '@plannotator/ui/components/InlineMarkdown';
import { DocumentLibrary } from './DocumentLibrary.tsx';
import { SettingsProvider, TextSettings } from './TextSettings.tsx';
import { PinnedWindows, ZoomControls, changesWindowId } from './PinnedWindows.tsx';
import { conversationShortcut, isConversationShortcut, isFrameShortcut } from './shortcuts.ts';
import { DocumentHeader } from './DocumentHeader.tsx';
import { OriginalDocument } from './OriginalDocument.tsx';
import { FilesPanel } from './FilesPanel.tsx';
import { useComparison, type WorkspaceFileChange } from './useComparison.ts';
import { isAnnotatableDocPath } from '@plannotator/core/annotatable';
import type { OpenFile } from './FilePreview.tsx';
import { pageTextSelector, type FileQuote } from '../src/quote.ts';
import { useResizablePanel } from '@plannotator/ui/hooks/useResizablePanel';
import { ResizeHandle } from '@plannotator/ui/components/ResizeHandle';
import { onCodeHighlightSwap } from '@plannotator/ui/utils/codeHighlight';
import { usePosition } from './usePosition.ts';
import { messagePreview } from './message-copy.ts';
import { ProposalReviewContext, useProposalReview } from './ProposalReview.tsx';

type Content = { html: string; markdown: string; version: string };
const insideRoot = (path: string, root: string) => path.startsWith(`${root.replace(/\/$/, '')}/`);

function keepsAttachment(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('.sidebar .composer, .sidebar-header, .thread-row, .sidebar-toggle, .files-edge-toggle, .files-panel, .file-preview, .html-topbar, .html-canvas');
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
  // A finished text selection in the HTML page: the same quick menu and floating comment as a Markdown passage.
  const [htmlPending, setHtmlPending] = useState<{ quote: FileQuote; rect: DOMRect } | null>(null);
  const article = useRef<HTMLElement>(null),
    workspace = useRef<HTMLDivElement>(null),
    viewer = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLElement>(null),
    toolbar = useRef<HTMLDivElement>(null);
  const painted = useRef(new Map<string, string>());
  const highlighter = useRef<Highlighter | null>(null),
    lastRect = useRef<DOMRect>(new DOMRect());
  const ignoreClick = useRef(false),
    pendingFocus = useRef<string | null>(null),
    sendingComment = useRef(false);
  const passageDrafts = useRef(new Map<string, QuestionDraft>());
  const draftKey = JSON.stringify(selection ?? htmlPending?.quote);
  const requestedDocument = new URL(location.href).searchParams.get('document');
  const documentId = requestedDocument ?? Object.keys(state?.documents ?? {})[0] ?? '';
  const current = state?.documents[documentId];
  const [unreadCount, setUnreadCount] = useState(0);
  const [urlHtmlView] = useState(readHtmlView);
  // A registered HTML file is itself the document: it always opens in the full-page HTML view.
  const isHtmlDocument = !!current && isHtmlPath(current.path);
  const htmlView: HtmlFile | null = urlHtmlView ?? (current && isHtmlDocument ? { documentId, path: current.path.slice(current.path.lastIndexOf('/') + 1), root: current.path.slice(0, current.path.lastIndexOf('/')) || '/', fragment: location.hash } : null);
  const htmlRoot = htmlView && (htmlView.root ?? current?.workspace);
  const htmlAbsolute = htmlView && htmlRoot ? `${htmlRoot.replace(/\/$/, '')}/${htmlView.path}` : undefined;
  // Only an HTML file opened from another document binds its threads; a standalone HTML document is the file itself.
  const threadFile = urlHtmlView ? htmlAbsolute : undefined;
  const [areScriptsEnabled, setScriptsEnabled] = useState(false), [isBridgeReady, setBridgeReady] = useState(false), [isPicking, setPicking] = useState(false);
  const [htmlNotice, setHtmlNotice] = useState(''), [htmlZoom, setHtmlZoom] = useState(100);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const prefix = unreadCount ? `(${unreadCount}) ` : '';
    if (urlHtmlView) document.title = `${prefix}${urlHtmlView.path.split('/').pop() || 'HTML file'} — Sidecar`;
    else if (current && !closedDocument) document.title = `${prefix}${current.title}`;
  }, [current?.title, unreadCount, closedDocument]);
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
  const threads = useMemo(() => {
    const listed = Object.values(state?.threads ?? {}).filter((thread) => thread.documentId === documentId && (!urlHtmlView || (!!threadFile && thread.file === threadFile)));
    if (!current || !isHtmlPath(current.path)) return listed;
    // Replies saved before HTML documents stored selector-less targets as page targets show them as page text, not stale Markdown passages.
    const proposed = new Set(Object.values(state?.proposals ?? {}).map(proposal => proposal.selectionId));
    return listed.map(thread => ({ ...thread, messages: thread.messages.map(message => {
      const legacy = message.role === 'agent' ? message.selections?.filter(selection => !proposed.has(selection.id)) ?? [] : [];
      if (!legacy.length) return message;
      const selections = message.selections!.filter(selection => !legacy.includes(selection));
      return { ...message, selections: selections.length ? selections : undefined, fileSelections: [...message.fileSelections ?? [], ...legacy.map(({ id, slug, label, quote }) => ({ id, slug, ...(label ? { label } : {}), fileQuote: { path: thread.file ?? current.path, kind: 'html' as const, exact: quote.exact, selector: pageTextSelector } }))] };
    }) }));
  }, [state?.threads, state?.proposals, documentId, urlHtmlView, threadFile, current?.path]);
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
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Mobile keyboards resize the visual viewport without resizing the page.
      if (!viewer.current || (viewport && viewport.scale !== 1)) return;
      viewer.current.style.setProperty('--mobile-height', `${viewport?.height ?? innerHeight}px`);
      viewer.current.style.setProperty('--mobile-top', `${viewport?.offsetTop ?? 0}px`);
    };
    // WebKit can dispatch viewport events before updating the reported geometry.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, []);
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
  const [changesScope, setChangesScope] = useState<string | null>(null);
  useEffect(() => { rootVisit.current++; setVisibleRoot(null); setFileReveal(null); setChangesScope(null); }, [documentId, current?.workspace]);
  const browserRoot = visibleRoot ?? current?.workspace;
  const [files, setFiles] = useState<OpenFile[]>([]);
  const comparison = useComparison(documentId, current?.workspace, current?.baseBranch, !!current?.workspace && (isFilesShown || !!changesScope || files.length > 0));
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
  // An iframe (an HTML page or file window) would take a fast drag's moves and release, ending the resize early.
  const isResizing = panelResize.isDragging || filesResize.isDragging;
  useLayoutEffect(() => { document.documentElement.toggleAttribute('data-resizing', isResizing); }, [isResizing]);
  const openThread = useCallback(
    (id: string | null) => {
      fileSelectionVisit.current++;
      const focusBeforeOpen = document.activeElement;
      setOriginalMessageId(null);
      drafts.flush();
      setSelection(id ? drafts.get(id)?.quote : undefined);
      setHtmlPending(null);
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
    setHtmlPending(null);
    // The HTML page's own selection goes too, as a captured Markdown passage leaves no native selection.
    frameRef.current?.contentWindow?.postMessage({ sidecar: 'html-bridge', type: 'unselect' }, '*');
    setComposing(false);
    setChoices(null);
  }, []);
  const openPreview = useCallback((path: string, refusal?: string, kind: OpenFile['kind'] = 'doc', root = current?.workspace, fragment?: string, lineRange?: FileLineRange) => {
    // Keep passage drafts; file windows cannot attach selections to the main document.
    clearPendingSelection();
    window.getSelection()?.removeAllRanges();
    const absolutePath = root && !refusal ? `${root.replace(/\/$/, '')}/${path}` : path;
    setPreviewPath(absolutePath);
    const id = `file:${absolutePath}`;
    setFiles(previous => {
      const existing = previous.find(file => file.id === id);
      const file = { id, path, root, kind, refusal, fragment, lineRange, isLineRangeVisible: true, areScriptsEnabled: existing?.areScriptsEnabled, revision: (existing?.revision ?? 0) + 1 };
      return existing ? previous.map(value => value.id === id ? file : value) : [...previous, file];
    });
    setOpenPins(previous => [...previous, id]);
    if (innerWidth <= 850) { setFilesShown(false); setSidebarShown(false); }
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
    const root = browserRoot && insideRoot(path, browserRoot) ? browserRoot
      : current?.workspace && insideRoot(path, current.workspace) ? current.workspace : path.slice(0, path.lastIndexOf('/')) || '/';
    void changeVisibleRoot(root, path);
  }
  const openAbsoluteFile = useCallback(async (absolutePath: string, kind?: OpenFile['kind'], fragment?: string, lineRange?: FileLineRange) => {
    const path = absolutePath.replace(/^\/\/+/, '/');
    const sourceRoot = browserRoot && insideRoot(path, browserRoot) ? browserRoot
      : current?.workspace && insideRoot(path, current.workspace) ? current.workspace : path.slice(0, path.lastIndexOf('/')) || '/';
    try {
      const root = await allowRoot(sourceRoot);
      openPreview(path.slice(sourceRoot.replace(/\/$/, '').length + 1), undefined, kind ?? (isAnnotatableDocPath(path) ? 'doc' : 'code'), root, fragment, lineRange);
    } catch (reason) { setError(errorText(reason)); }
  }, [browserRoot, current?.workspace, allowRoot, openPreview]);
  // The Changed files window is a singleton: asking again retargets its scope and raises it.
  const openChanges = useCallback((scope: string) => {
    setChangesScope(scope);
    setOpenPins(previous => [...previous, changesWindowId]);
  }, []);
  const openChange = useCallback((change: WorkspaceFileChange) => {
    void openAbsoluteFile(change.path);
    revealFile(change.path);
  }, [openAbsoluteFile, revealFile]);
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
    const [source, suffix] = splitLineSuffix(target);
    const html = !suffix && kind === 'doc' ? source.match(/^([^#]*\.html?)(#.*)$/i) : null;
    const file = html ? html[1] : source;
    const lineRange = fileLineRange(suffix);
    const resolved = resolveLink(kind, file, baseDir);
    if (!resolved) openPreview(file, 'This document has no recorded workspace. Reopen it from your agent.');
    else void openAbsoluteFile('outside' in resolved ? resolved.outside : `${workspaceRoot.current}/${resolved.path}`, kind, html?.[2], lineRange);
  };
  // Stable identity so memoized documents and messages do not re-render on every state tick.
  const openLink = useCallback<OpenWorkspaceLink>((...args) => handleLink.current(...args), []);
  useEffect(() => {
    // Plannotator's hover preview for `path:line` code references reads Sidecar's code route.
    setDocPreviewFetcher(async (candidate) => {
      const [file] = splitLineSuffix(candidate);
      const resolved = resolveLink('code', file);
      if (!resolved || 'outside' in resolved) return null;
      const response = await fetch(viewerPath(`/api/files/code?document=${encodeURIComponent(documentId)}&path=${encodeURIComponent(resolved.path)}`));
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
    if (!documentId || closedDocument) return;
    const key = `sidecar-closed-document:${documentId}`;
    const showClosed = () => documentClosed({ documentId, threadIds: [], nextDocumentId: null });
    const onStorage = (event: StorageEvent) => { if (event.key === key && event.newValue === '1') showClosed(); };
    // A stopped viewer cannot broadcast closure; the library still updates its open tabs.
    try { if (localStorage.getItem(key) === '1') showClosed(); } catch { /* Live viewer events still work without storage. */ }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [documentId, closedDocument, documentClosed]);
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
          // A slow history response must not rewind newer text/status received over the live stream.
          if (!latestRuntime || next.runtimeRevision >= latestRuntime.runtimeRevision) {
            const { stateRevision, runtimeRevision, stream, streams, agentControl, activity, reset, connectionError } = next;
            latestRuntime = { stateRevision, runtimeRevision, stream, streams, agentControl, activity, reset, connectionError };
          }
          const runtime = latestRuntime, hadSnapshot = snapshotGeneration === generation;
          snapshotGeneration = generation;
          setState(current => mergeRuntime(
            hadSnapshot && current && current.runtimeRevision > next.runtimeRevision ? { ...next, stream: current.stream, streams: current.streams } : next,
            runtime,
          ));
          const id = requestedDocument ?? Object.keys(next.documents)[0] ?? '';
          const doc = next.documents[id];
          if (!doc) { setContent({ html: '', markdown: '', version: '' }); continue; }
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
    const events = new ViewerEvents(viewerPath('/api/events?updates=1'));
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
        (innerWidth <= 850 && isSidebarShown) ||
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
  }, [selection, composing, choices, openComment, isSidebarShown]);
  // Plannotator dismisses the quick menu and pending highlight on an outside press.
  useEffect(() => {
    if (!(selection || htmlPending) || composing) return;
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
  }, [selection, htmlPending, composing, clearSelection]);
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
    if (htmlPending) return htmlPending.rect;
    const root = article.current;
    const range = root && selection && quoteRange(root, selection, content.version);
    if (range) lastRect.current = range.getBoundingClientRect();
    return lastRect.current;
  }, [selection, htmlPending, choices, content.version]);
  usePosition(composer, composing ? anchor : null, 384);
  usePosition(toolbar, ((selection || htmlPending) && !composing) || choices ? anchor : null, choices ? 300 : 76, !choices);

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
    return quote;
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
    if (ids.length && innerWidth > 850) setSidebarShown(true);
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
  async function attachToConversation(attachment: { fileQuote: FileQuote } | { quote: Quote }) {
    const visit = ++fileSelectionVisit.current;
    if ('fileQuote' in attachment) clearPendingSelection();
    ignoreClick.current = true;
    requestAnimationFrame(() => { ignoreClick.current = false; });
    try {
      let target = activeThreadId;
      if (!target) {
        fileThread.current ??= api<Thread>('/api/threads', { id: randomId(), documentId, ...(threadFile ? { file: threadFile } : {}) });
        const thread = await fileThread.current;
        setState(previous => previous ? { ...previous, threads: { ...previous.threads, [thread.id]: thread } } : previous);
        target = thread.id;
      }
      if (visit !== fileSelectionVisit.current) return;
      const { quote, messageQuote, fileQuote, ...draft } = drafts.get(target) ?? { text: '', retry: null };
      drafts.set(target, { ...draft, ...attachment });
      if (activeThreadId !== target || !isSidebarShown) openThread(target);
      else if ('quote' in attachment) setSelection(attachment.quote);
      setError('');
    } catch (reason) { fileThread.current = null; setError(errorText(reason)); }
  }
  function showConversations() {
    if (isSidebarShown) return;
    const pending = captureSelection() ?? selection;
    if (pending && !composing) void attachToConversation({ quote: pending });
    else if (htmlPending && !composing) void attachToConversation({ fileQuote: htmlPending.quote });
    else setSidebarShown(true);
  }
  const toggleConversations = () => isSidebarShown ? setSidebarShown(false) : showConversations();
  const latestToggle = useRef(toggleConversations);
  latestToggle.current = toggleConversations;
  // Window capture runs before any field, editor or button handler; HTML frames forward the key themselves.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!isConversationShortcut(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      latestToggle.current();
    };
    const frame = (event: MessageEvent) => { if (isFrameShortcut(event)) latestToggle.current(); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('message', frame);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('message', frame); };
  }, []);
  const attachHtml = (exact: string, selector: string, fingerprint?: string) => {
    if (htmlAbsolute) void attachToConversation({ fileQuote: { path: htmlAbsolute, kind: 'html', exact, selector, ...(fingerprint ? { isElement: true, fingerprint } : {}) } });
  };
  // The last reported page position, restored only after an agent revision reloads the frame (never after a user's own change).
  const pageScroll = useRef<{ type: 'scroll'; x: number; y: number } | null>(null), restoreScroll = useRef<typeof pageScroll.current>(null);
  const postBridge = useHtmlBridge(frameRef, message => {
    if (message.type === 'ready') {
      setBridgeReady(true); setPicking(false);
      if (restoreScroll.current) postBridge(restoreScroll.current);
      restoreScroll.current = null;
    }
    else if (message.type === 'scroll') {
      pageScroll.current = message;
      // The quick menu would no longer sit beside the text; an attached quote stays on the draft.
      if (htmlPending && !composing) setHtmlPending(null);
    }
    else if (message.type === 'selection') {
      // As captureSelection does for a Markdown passage: offer the quick menu and attach to the visible thread.
      // Page events never reach this document, so a press in the page is the outside press here: it dismisses the
      // menu, or an empty floating comment, and a new selection replaces them; typed comment text is never dropped.
      const hasText = composing && (sendingComment.current || !!passageDrafts.current.get(draftKey)?.text.trim());
      if (!message.exact || !message.rect) {
        if (htmlPending && !hasText) { if (composing) passageDrafts.current.delete(draftKey); clearSelection(); }
        return;
      }
      const frame = frameRef.current?.getBoundingClientRect(), zoom = htmlZoom / 100, box = message.rect;
      if (!htmlAbsolute || !frame || hasText) return;
      if (composing) passageDrafts.current.delete(draftKey);
      const quote: FileQuote = { path: htmlAbsolute, kind: 'html', exact: message.exact, selector: message.selector };
      fileSelectionVisit.current++;
      setHtmlPending({ quote, rect: new DOMRect(frame.left + box.left * zoom, frame.top + box.top * zoom, (box.right - box.left) * zoom, (box.bottom - box.top) * zoom) });
      if (activeThreadId && isSidebarShown) {
        const { quote: _, messageQuote, fileQuote, ...rest } = drafts.get(activeThreadId) ?? { text: '', retry: null };
        drafts.set(activeThreadId, { ...rest, fileQuote: quote });
      }
      setComposing(false);
      setChoices(null);
    }
    else if (message.type === 'pick') { setPicking(false); attachHtml(message.exact, message.selector, message.fingerprint); }
    else if (message.type === 'picker') setPicking(false);
    else if (message.type === 'open-file') openPageLink(message.href);
    else setHtmlNotice(message.ok ? '' : 'This part of the page changed or was removed since it was attached.');
  });
  // Page links are untrusted input: open only files inside the registered workspace, never grant another root.
  const openPageLink = (href: string) => {
    const root = current?.workspace, target = root && htmlAbsolute ? pageLinkTarget(href, root, htmlAbsolute.replace(/\/[^/]*$/, '')) : null;
    // A click in the frame activates this page too; a script posting on its own (e.g. at load) does not.
    if (navigator.userActivation?.isActive === false) return;
    // A standalone HTML document opened without a workspace grants no other file.
    if (!root) return setHtmlNotice('Files open from the page only when this document has a workspace. Reopen it from your agent with one.');
    if (!target) return;
    if ('outside' in target) return setHtmlNotice(`Only files inside this document’s workspace open from the page: ${target.outside}`);
    setHtmlNotice('');
    openPreview(target.path, undefined, isAnnotatableDocPath(target.path) ? 'doc' : 'code', root, target.fragment, target.lineRange);
  };
  const changeScripts = (enabled: boolean) => {
    setScriptsEnabled(enabled); setBridgeReady(false); setPicking(false); setHtmlNotice(''); pageScroll.current = null; restoreScroll.current = null;
    // The reloaded page has no selection; only typed floating-comment text keeps its quote.
    if (htmlPending && !(composing && passageDrafts.current.get(draftKey)?.text.trim())) clearPendingSelection();
  };
  // Agent revisions to a standalone HTML document reload its frame, keeping the Run scripts choice.
  const htmlRevision = isHtmlDocument && !urlHtmlView ? current?.version ?? '' : '';
  useEffect(() => {
    if (!htmlRevision) return;
    const position = pageScroll.current;
    changeScripts(areScriptsEnabled);
    restoreScroll.current = position;
  }, [htmlRevision]);
  const togglePicker = (on: boolean) => { setPicking(on); postBridge({ type: 'picker', on }); };
  useEffect(() => {
    if (!isPicking) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') togglePicker(false); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [isPicking]);
  // A saved HTML target from another view opens its page's full-page view, which reveals it once Run scripts is on.
  // The tab opens inside the click gesture; an outside root is granted first, then that tab navigates.
  const [blockedPage, setBlockedPage] = useState<string | null>(null);
  function openHtmlPage(path: string, revealId: string) {
    const workspace = current?.workspace, inside = !!workspace && insideRoot(path, workspace);
    const sourceRoot = inside ? workspace! : path.slice(0, path.lastIndexOf('/')) || '/';
    const url = (root: string) => new URL(htmlFullPageUrl({ documentId, path: path.slice(sourceRoot.replace(/\/$/, '').length + 1), root }, revealId), location.href).href;
    const tab = window.open(inside ? url(sourceRoot) : 'about:blank', '_blank');
    if (tab) tab.opener = null;
    setBlockedPage(null);
    if (inside) { if (!tab) setBlockedPage(url(sourceRoot)); return; }
    void allowRoot(sourceRoot).then(root => {
      if (tab && !tab.closed) tab.location.href = url(root);
      else setBlockedPage(url(root));
    }, reason => { tab?.close(); setError(errorText(reason)); });
  }
  const selectionActions = {
    onOpenFileQuote: (quote: FileQuote, revealId?: string) => {
      if (quote.kind === 'html' && quote.selector && revealId && quote.path !== htmlAbsolute) return openHtmlPage(quote.path, revealId);
      if (!htmlView || quote.kind !== 'html' || quote.path !== htmlAbsolute || !quote.selector) return openLink(quote.kind === 'code' ? 'code' : 'doc', quote.path);
      if (innerWidth <= 850) setSidebarShown(false);
      if (!areScriptsEnabled) return setHtmlNotice('Turn on Run scripts to show this on the page.');
      setHtmlNotice('');
      postBridge({ type: 'reveal', selector: quote.selector, exact: quote.exact, isElement: !!quote.isElement, fingerprint: quote.fingerprint });
    },
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
  // ?reveal= from another view: open its thread now, reveal once the user turns on Run scripts and the page is ready.
  const [revealId, setRevealId] = useState(() => urlHtmlView ? revealParameter() : null);
  const revealTarget = revealId ? threads.flatMap(thread => thread.messages.flatMap(message => [
    ...(message.id === revealId && message.fileQuote ? [message.fileQuote] : []), ...(message.fileSelections ?? []).filter(s => s.id === revealId).map(s => s.fileQuote),
  ].filter(quote => quote.path === htmlAbsolute).map(quote => ({ thread, quote }))))[0] : undefined;
  const revealThread = useRef<string | null>(null);
  useEffect(() => {
    if (!revealId || !state) return;
    if (!revealTarget) { setRevealId(null); return; }
    if (revealThread.current !== revealTarget.thread.id) { revealThread.current = revealTarget.thread.id; openThread(revealTarget.thread.id); }
    if (!areScriptsEnabled) { setHtmlNotice('Turn on Run scripts to show this on the page.'); return; }
    if (!isBridgeReady) return;
    setRevealId(null);
    selectionActions.onOpenFileQuote(revealTarget.quote);
  }, [revealId, !!state, !!revealTarget, areScriptsEnabled, isBridgeReady]);
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
          <a href={libraryPath()}>Browse all documents</a>
        </div>
      </main>
    </>
  );
  return (
    <WorkspaceLinks.Provider value={openLink}>
      <ProposalReviewContext.Provider value={proposalReview.context}>
      {proposalReview.popover}
      <div className={`viewer${htmlView ? ' html-view' : ''}`} ref={viewer} data-chat-open={isSidebarShown}>
      <header className={`topbar${htmlView ? ' html-topbar' : ''}`}>
        {htmlView ? <HtmlControls file={htmlView} isDocument={!urlHtmlView} areScriptsEnabled={areScriptsEnabled} onScripts={changeScripts} isReady={areScriptsEnabled && isBridgeReady}
          isPicking={isPicking} onPick={() => togglePicker(!isPicking)} zoom={htmlZoom} onZoom={setHtmlZoom} /> : <>
        <div className="brand">
          <Icon name="logo" />
          <span>Sidecar</span>
        </div>
        <span className="separator" />
        {current && <TitleForm key={documentId} id={documentId} title={current.title} />}
        {Object.keys(state?.documents ?? {}).length > 1 && (
          <select
            className="document-picker"
            aria-label="Documents"
            value={documentId}
            onChange={(event) => {
              location.href = viewerPath(`/?document=${event.target.value}`);
            }}
          >
            {Object.values(state?.documents ?? {}).map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.title}
              </option>
            ))}
          </select>
        )}
        </>}
        <AgentStatus state={state} connected={connected} />
        <TextSettings version={state?.appVersion}>
          {/* Also here because a phone header has no room for the page's zoom controls. */}
          {htmlView && <div className="text-settings-heading brightness-heading"><span>HTML page zoom</span><ZoomControls zoom={htmlZoom} onZoom={setHtmlZoom} /></div>}
        </TextSettings>
        <button
          className="sidebar-toggle conversation-toggle"
          aria-label={isSidebarShown ? 'Hide conversations' : 'Show conversations'}
          title={`${isSidebarShown ? 'Hide conversations' : 'Show conversations'} (${conversationShortcut.label})`}
          aria-keyshortcuts={conversationShortcut.aria}
          aria-expanded={isSidebarShown}
          aria-controls="conversation-sidebar"
          onPointerDown={() => { if (!isSidebarShown) captureSelection(); }}
          onClick={toggleConversations}
        >
          <Icon name="panel" />
          <span>{isSidebarShown ? 'Document' : 'Chat'}</span>
        </button>
        {current && !htmlView && (
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
      {blockedPage && <p className="app-error" role="alert">The browser blocked the new tab. <a href={blockedPage} target="_blank" rel="noopener noreferrer" onClick={() => setBlockedPage(null)}>Open the HTML page</a></p>}
      {error && (
        <p className="app-error" role="alert">
          {error}
        </p>
      )}
      <div className={`layout${isSidebarShown ? '' : ' sidebar-collapsed'}${isFilesShown && current?.workspace ? ' files-open' : ''}`}>
        {isFilesShown && current?.workspace && (
          <>
            <FilesPanel key={`${documentId}:${browserRoot}`} documentId={documentId} root={browserRoot ?? current.workspace} workspace={current.workspace}
              activePath={previewPath} reveal={fileReveal} comparison={comparison} onSelect={openAbsoluteFile} onRootChange={changeVisibleRoot} onOpenChanges={openChanges} />
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
        <div className="document-workspace" id="document-workspace" ref={workspace}>
        <main className={`canvas${htmlView ? ' html-canvas' : ''}`} style={htmlView ? { '--html-zoom': htmlZoom / 100 } as React.CSSProperties : undefined}>
          {htmlView ? <>
            {htmlNotice && <p className="html-notice" role="status">{htmlNotice}</p>}
            {htmlView.root || current?.workspace ? <HtmlFileViewer key={`${htmlView.path}:${htmlRoot}:${htmlRevision}`} file={htmlView} areScriptsEnabled={areScriptsEnabled} bridge frameRef={frameRef} />
              : state ? <p role="alert">This document has no recorded workspace. Reopen it from your agent.</p> : <p role="status">Loading HTML file…</p>}
          </> : <div className="reading-width">
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
          </div>}
        </main>
        <PinnedWindows key={documentId} workspace={workspace} threads={threads} files={files} onSetLineRangeVisible={(id, visible) => setFiles(previous => previous.map(file => file.id === id ? { ...file, isLineRangeVisible: visible } : file))} onSetFileScripts={(id, enabled) => setFiles(previous => previous.map(file => file.id === id ? { ...file, areScriptsEnabled: enabled } : file))} root={current?.workspace} documentId={documentId} comparison={comparison} changesScope={changesScope} onCloseChanges={() => setChangesScope(null)} onOpenChange={openChange} onQuoteFile={fileQuote => attachToConversation({ fileQuote })} onRevealFile={revealFile} openRequests={openPins} onOpened={ids => setOpenPins(previous => previous.filter(id => !ids.includes(id)))} onCloseFile={id => {
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
          onUnreadChange={setUnreadCount}
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
          stream={state?.streams?.filter(reply => reply.threadId === activeThreadId).at(-1) ?? state?.stream ?? null}
          agentControl={state?.agentControl}
          isCompacting={state?.activity === 'compacting'}
          {...selectionActions}
          isShown={isSidebarShown}
          drafts={drafts}
          onRemoveSelection={clearSelection}
          activeMessageId={selectedMessages.find(({ selection }) => selection.id === activeMessageId)?.message.id ?? null}
          messageVisit={messageVisit}
          onMessageSent={request => setSentRequestId(request.id)}
          onOpenPin={id => {
            setOpenPins(previous => [...previous.filter(value => value !== id), id]);
            if (innerWidth <= 850) setSidebarShown(false);
          }}
          onGoToMessage={goToMessage}
          messageJump={messageJump}
          threadFile={threadFile}
        />
      </div>
      </div>
      {(((selection || htmlPending) && !composing) || choices) &&
        createPortal(
          <div
            ref={toolbar}
            key={choices ? 'choices' : draftKey}
            className={`floating selection-actions${choices ? '' : ' annotation-toolbar'}${isSidebarShown ? ' chat-open' : ''}`}
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
                {/* C reaches this document only from a Markdown passage; an HTML page keeps its own keys. */}
                <button
                  className="comment-action"
                  onClick={openComment}
                  aria-label="Comment"
                  aria-keyshortcuts={htmlPending ? undefined : 'c'}
                  title={htmlPending ? 'Comment' : 'Comment (C)'}
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
        (selection || htmlPending) &&
        createPortal(
          <section ref={composer} className={`floating comment-popover${isSidebarShown ? ' chat-open' : ''}`} role="dialog" aria-label="Comment on selection">
            <QuestionForm
              key={draftKey}
              documentId={documentId}
              quote={selection}
              fileQuote={htmlPending?.quote}
              threadFile={htmlPending ? threadFile : undefined}
              quoteIssue={selection ? passageIssue(selection) : null}
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
const query = new URLSearchParams(location.search);
if (root) createRoot(root).render(<SettingsProvider>{query.get('view') === 'html' && !isHtmlViewValid(readHtmlView()!) ? <p role="alert">Open this page with a document and file from its Sidecar viewer.</p> : (query.has('library') || isGateway && !query.has('document')) ? <DocumentLibrary /> : <App />}</SettingsProvider>);
