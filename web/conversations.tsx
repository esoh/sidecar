import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@plannotator/ui/components/ui/dropdown-menu';
import { threadMatch } from './thread-search.ts';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@plannotator/ui/components/Popover';
import type { Message, MessageSelection as SavedSelection, Quote, RequestRecord, Thread } from '../src/store.ts';
import { api, errorText, type ViewerState } from './api.ts';
import { AgentSession } from './AgentSession.tsx';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { copyMessage, messagePreview } from './message-copy.ts';
import { useMessageSettings } from './TextSettings.tsx';
import { isPinIcon, pinColors, pinIcons, type PinStyle } from '../src/pin-style.ts';

import type { QuestionDraft, QuestionDrafts } from './useQuestionDrafts.ts';
import type { MessageQuote } from '../src/quote.ts';
import { excludedSelection, selectionText } from './selection.ts';

const paths = {
  minimize: 'M5 18h14',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z',
  bookmark: 'M6 3h12v18l-6-4-6 4V3Z',
  flag: 'M5 21V3m0 1h14l-3 5 3 5H5',
  bulb: 'M9 18h6m-6 3h6M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
  tag: 'M3 3h8l10 10-8 8L3 11V3Zm4 4h.01',
  target: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM12 12h.01',
  pin: 'm16 3 5 5-5 2-2 5-2 2-5-5 2-2 5-2 2-5ZM8 16l-5 5',
  copy: 'M9 9h12v12H9zM15 6V3H3v12h3',
  dock: 'M3 3h18v18H3zM3 15h18',
  more: 'M5 11v2M12 11v2M19 11v2',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  eyeOff: 'm3 3 18 18M10 5a12 12 0 0 1 2 0c6.5 0 10 7 10 7a22 22 0 0 1-3 4M6 6a22 22 0 0 0-4 6s3.5 7 10 7a13 13 0 0 0 5-1M9 9a4 4 0 0 0 6 6',
  chevron: 'm6 9 6 6 6-6',
  arrowUpRight: 'M7 17 17 7M7 7h10v10',
  back: 'M19 12H5m6-6-6 6 6 6',
  send: 'M12 19V5m-6 6 6-6 6 6',
  stop: 'M6 6h12v12H6z',
  pencil: 'm16 3 5 5L8 21H3v-5L16 3ZM14 5l5 5',
  check: 'm5 12 4 4L19 6',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6l4 2',
  comment: 'M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2z',
  annotation: 'm14 4 6 6-9 9H5v-6zM11 7l6 6M3 22h10',
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M6 18 18 6',
  logo: 'M4 4h16v16H4zM15 4v16',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z',
  panel: 'M14 3v18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
};
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg className="sidecar-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
export function QuestionForm({
  documentId,
  threadId,
  quote,
  messageQuote,
  quoteChanged = false,
  onSent,
  floating = false,
  onCancel,
  disabled = false,
  drafts,
  draftKey,
  onSendingChange,
  onRemoveSelection,
  stream,
}: {
  documentId: string;
  threadId?: string;
  quote?: Quote;
  messageQuote?: MessageQuote;
  quoteChanged?: boolean;
  onSent: (request: RequestRecord) => void;
  floating?: boolean;
  onCancel?: () => void;
  disabled?: boolean;
  drafts: QuestionDrafts;
  draftKey: string;
  onSendingChange?: (sending: boolean) => void;
  onRemoveSelection?: () => void;
  stream?: ViewerState['stream'];
}) {
  const [initialDraft] = useState(() => drafts.get(draftKey));
  const [text, setText] = useState(initialDraft?.text ?? ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null), sending = useRef(false);
  const retry = useRef(initialDraft?.retry ?? null);
  const [isStopping, setStopping] = useState(false);
  const hasStop = !floating && !text.length && stream && stream.threadId === threadId && (stream.canStop || stream.stopping);
  const attachment = messageQuote ? { messageQuote } : quote ? { quote } : {};
  const attachedText = messageQuote?.exact ?? quote?.exact;
  const updateDraft = (draft: QuestionDraft, immediately = false) => {
    drafts.set(draftKey, draft);
    if (immediately) drafts.flush();
  };
  useEffect(() => () => drafts.flush(), [drafts, draftKey]);
  useLayoutEffect(() => {
    if (floating) input.current?.focus({ preventScroll: true });
  }, [floating]);
  const cancel = () => {
    if (!sending.current) {
      setText('');
      retry.current = null;
      drafts.remove(draftKey);
      setError('');
      onCancel?.();
    }
  };
  return (
    <form
      className="composer"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || sending.current || !text.trim() || !documentId) return;
        const body = { documentId, text, ...(threadId ? { threadId } : {}), ...attachment };
        const signature = JSON.stringify(body);
        if (retry.current?.signature !== signature) retry.current = { signature, id: crypto.randomUUID() };
        const submittedDraft = { text, retry: retry.current, ...attachment };
        updateDraft(submittedDraft, true);
        sending.current = true;
        setBusy(true);
        onSendingChange?.(true);
        try {
          const request = await api<RequestRecord>('/api/questions', { ...body, clientMessageId: retry.current.id });
          // A remounted composer or a newly attached quote may hold a newer draft.
          if (drafts.get(draftKey) === submittedDraft) {
            setText(''); retry.current = null;
            drafts.remove(draftKey, submittedDraft);
          }
          setError('');
          onSent(request);
        } catch (reason) {
          setError(errorText(reason));
        } finally {
          sending.current = false;
          setBusy(false);
          onSendingChange?.(false);
        }
      }}
      onKeyDown={(event) => {
        if (floating && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
        if (
          event.target === input.current &&
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229
        ) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      {floating && (
        <div className="comment-header">
          <span className="quote-preview" data-testid="selection-preview" title={quote?.exact}>
            {quote?.exact}
            {quoteChanged ? ' (Passage changed.)' : ''}
          </span>
          <button
            className="cancel-button"
            type="button"
            aria-label="Cancel"
            title="Close comment"
            onClick={cancel}
            disabled={busy}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {!floating && attachedText && (
        <div className="draft-selection">
          <span className="selection-badge text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">{messageQuote ? 'quote' : 'selection'}</span>
          <span className="quote-excerpt text-[10px] text-muted-foreground/70 border-l border-border pl-2 mb-1.5" title={attachedText}>{attachedText}</span>
          <button type="button" className="cancel-button" aria-label="Remove selection" onClick={onRemoveSelection}><Icon name="close" /></button>
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={input}
          aria-label={floating ? 'Comment' : 'Message'}
          placeholder="Ask a question or request a change…"
          required
          value={text}
          readOnly={busy || disabled}
          onBlur={drafts.flush}
          onChange={(event) => {
            setText(event.target.value);
            updateDraft({ text: event.target.value, retry: retry.current, ...attachment });
          }}
        />
      <div className="composer-actions">
          {hasStop ? <button type="button" className="send-button" aria-label="Stop response" title={stream?.stopping || isStopping ? 'Stopping…' : 'Stop response'} disabled={isStopping || stream?.stopping} onClick={async () => {
            if (!stream?.turnId || isStopping) return;
            setStopping(true); setError('');
            try { await api(`/api/requests/${stream.requestId}/stop`, { turnId: stream.turnId }); }
            catch (reason) { setError(errorText(reason)); }
            finally { setStopping(false); }
          }}><Icon name="stop" /></button> : <button
            className="send-button"
            aria-label={floating ? 'Send comment' : 'Send message'}
            disabled={disabled || busy || !text.trim()}
          >
            {floating ? 'Send' : <Icon name="send" />}
          </button>}
        </div>
      </div>
      {(error || drafts.error) && <p role="alert">{error || drafts.error}</p>}
      {stream && stream.threadId === threadId && stream.stopping && <span role="status">Stopping…</span>}
      {stream && stream.threadId === threadId && stream.stopError && <p role="alert">{stream.stopError}</p>}
    </form>
  );
}

export function TitleForm({ id, title, kind = 'document' }: { id: string; title: string; kind?: 'document' | 'thread' }) {
  const label = kind === 'thread' ? 'Thread title' : 'Document name';
  const Heading = kind === 'thread' ? 'h2' : 'span';
  const [draft, setDraft] = useState<string | null>(null),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    pencil = useRef<HTMLButtonElement>(null),
    saving = useRef(false),
    queuedSave = useRef<{ value: string; version: number; restoreFocus: boolean } | null>(null),
    revision = useRef(0),
    restorePencil = useRef(false);
  useLayoutEffect(() => {
    if (draft !== null) {
      input.current?.focus();
      input.current?.select();
    } else if (restorePencil.current) {
      restorePencil.current = false;
      pencil.current?.focus();
    }
  }, [draft === null]);
  async function save(restoreFocus: boolean) {
    if (draft === null) return;
    queuedSave.current = { value: draft.trim(), version: revision.current, restoreFocus };
    if (saving.current) return;
    saving.current = true;
    let savedTitle = title;
    try {
      while (queuedSave.current) {
        const pending = queuedSave.current;
        queuedSave.current = null;
        try {
          if (pending.value && pending.value !== savedTitle) {
            await api(`/api/${kind === 'thread' ? 'threads' : 'documents'}/${id}/title`, { title: pending.value }, 'PATCH');
            savedTitle = pending.value;
          }
          setError('');
          if (pending.version === revision.current) {
            restorePencil.current = pending.restoreFocus && document.activeElement === input.current;
            setDraft(null);
          }
        } catch (reason) {
          if (input.current) setError(errorText(reason));
        }
      }
    } finally {
      saving.current = false;
    }
  }
  return (
    <div className={`document-name${kind === 'thread' ? ' thread-name' : ''}`}>
      <Heading className={kind === 'thread' ? 'conversation-title' : undefined} hidden={draft !== null} title={title}>
        {title}
      </Heading>
      <button
        ref={pencil}
        className="edit-title"
        hidden={draft !== null}
        aria-label={`Edit ${label.toLowerCase()}`}
        title={`Edit ${label.toLowerCase()}`}
        onClick={() => {
          revision.current++;
          setDraft(title);
        }}
      >
        <Icon name="pencil" />
      </button>
      {draft !== null && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(true);
          }}
        >
          <input
            ref={input}
            aria-label={label}
            maxLength={kind === 'thread' ? 80 : 120}
            value={draft}
            onChange={(event) => {
              revision.current++;
              setDraft(event.target.value);
            }}
            onBlur={() => {
              void save(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                revision.current++;
                queuedSave.current = null;
                restorePencil.current = true;
                setDraft(null);
                setError('');
              }
            }}
          />
        </form>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function AgentStatus({ state, connected }: { state: ViewerState | null; connected: boolean }) {
  const labels = {
    unknown: 'Unknown',
    busy: 'Busy',
    idle: 'Idle',
    waiting: 'Waiting for input',
    disconnected: 'Disconnected',
    compacting: 'Compacting',
  };
  const activity = state?.activity ?? 'unknown';
  const label = !connected ? 'Reconnecting…' : state?.connectionError ? 'Connection error' : labels[activity];
  const indicator = !connected ? 'reconnecting' : state?.connectionError ? 'error' : activity;
  const queued = Object.values(state?.requests ?? {}).filter((request) => request.status === 'queued').length;
  return (
    <span className="agent-status" role="status" aria-label="Agent status">
      <Tooltip
        content={`Status: ${label}${state?.connectionError ? ` — ${state.connectionError}` : ''}`}
        side="bottom"
        align="end"
        wide={!!state?.connectionError}
      >
        <span className="agent-indicator" tabIndex={0} aria-label={`Status: ${label}`}>
          <span className="agent-dot" data-activity={indicator} aria-hidden="true" />
        </span>
      </Tooltip>
      <span>
        {state ? <AgentSession owner={state.owner} /> : 'Agent'}
        <span className="sr-only"> · {label}</span>
        {queued ? ` · ${queued} queued` : ''}
      </span>
    </span>
  );
}

function activity(thread: Thread) {
  return thread.messages.at(-1)?.createdAt ?? thread.createdAt ?? 0;
}
export function age(time: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  if (minutes < 43200) return `${Math.floor(minutes / 10080)}w`;
  if (minutes < 525600) return `${Math.floor(minutes / 43200)}mo`;
  return `${Math.floor(minutes / 525600)}y`;
}
export function ConversationSidebar({
  documentId,
  threads,
  activeId,
  onOpen,
  onCreated,
  requests,
  stream,
  passageChanged,
  showPassage,
  showOriginal,
  isShown,
  drafts,
  onRemoveSelection,
  activeMessageId,
  activeSelectionId,
  messageVisit,
  onMessageSent,
  onOpenPin,
  onGoToMessage,
  messageJump,
  onQuoteMessage,
}: {
  documentId: string;
  threads: Thread[];
  activeId: string | null;
  onOpen: (id: string | null) => void;
  onCreated: (thread: Thread) => void;
  requests: RequestRecord[];
  stream: ViewerState['stream'];
  passageChanged: (quote: Quote) => boolean;
  showPassage: (selection: SavedSelection) => void;
  showOriginal: (messageId: string) => void;
  isShown: boolean;
  drafts: QuestionDrafts;
  onRemoveSelection: () => void;
  activeMessageId: string | null;
  activeSelectionId: string | null;
  messageVisit: number;
  onMessageSent: (request: RequestRecord) => void;
  onOpenPin: (messageId: string) => void;
  onGoToMessage: (messageId: string) => void;
  messageJump: { id: string; sequence: number } | null;
  onQuoteMessage: (quote: MessageQuote) => void;
}) {
  const [filter, setFilter] = useState('unresolved'),
    [search, setSearch] = useState(''),
    [error, setError] = useState(''),
    [creating, setCreating] = useState(false),
    [isLeaving, setLeaving] = useState(false);
  const readKey = 'sidecar-read-reply:';
  const [readReplies, setReadReplies] = useState<Record<string, string>>(() => {
    try {
      return Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.startsWith(readKey))
          .map((key) => [key.slice(readKey.length), localStorage.getItem(key) ?? '']),
      );
    } catch {
      return {};
    }
  });
  useEffect(() => {
    const syncRead = (event: StorageEvent) => {
      if (event.storageArea === localStorage && event.key?.startsWith(readKey)) {
        const id = event.key.slice(readKey.length);
        setReadReplies((previous) => ({ ...previous, [id]: event.newValue ?? '' }));
      }
    };
    window.addEventListener('storage', syncRead);
    return () => window.removeEventListener('storage', syncRead);
  }, []);
  const creatingId = useRef<string | null>(null),
    createBusy = useRef(false);
  const positions = useRef(new Map<string, number>());
  const messages = useRef<HTMLDivElement>(null),
    back = useRef<HTMLButtonElement>(null),
    filterInput = useRef<HTMLButtonElement>(null);
  const previousId = useRef<string | null>(null),
    atBottom = useRef(true);
  const handledJump = useRef<number | null>(null);
  const active = threads.find((thread) => thread.id === activeId);
  const requestStatuses = new Map(requests.map((request) => [request.id, request.status]));
  const latestMessages = new Map(active?.messages.map(message => [message.requestId, message.id]));
  const inProgress = new Set(
    requests.filter((request) => request.status === 'claimed').map((request) => request.threadId),
  );
  const queuedThreads = new Set(
    requests.filter((request) => request.status === 'queued').map((request) => request.threadId),
  );
  useEffect(() => {
    const markRead = () => {
      if (document.visibilityState !== 'visible' || !messages.current?.getClientRects().length) return;
      const reply = active?.messages.filter((message) => message.role === 'agent').at(-1);
      if (active && reply && readReplies[active.id] !== reply.id) {
        try {
          localStorage.setItem(`${readKey}${active.id}`, reply.id);
        } catch {
          /* Reading still works without storage. */
        }
        setReadReplies((previous) => ({ ...previous, [active.id]: reply.id }));
      }
    };
    markRead();
    document.addEventListener('visibilitychange', markRead);
    window.addEventListener('resize', markRead);
    return () => {
      document.removeEventListener('visibilitychange', markRead);
      window.removeEventListener('resize', markRead);
    };
  }, [active, isShown, readReplies]);
  const query = search.trim();
  const matches = new Map(threads.map(thread => [thread.id, query ? threadMatch(thread, query) : null]));
  const visible = threads
    .filter((thread) => (filter === 'all' || thread.isResolved === (filter === 'resolved')) && (!query || matches.get(thread.id)))
    .sort((a, b) => activity(b) - activity(a));
  const text = active && stream?.threadId === active.id ? stream.text : '';
  useLayoutEffect(() => {
    if (!isShown) return;
    const node = messages.current;
    if (active && node) {
      if (previousId.current !== active.id) {
        node.scrollTop = positions.current.get(active.id) ?? 0;
        back.current?.focus({ preventScroll: true });
      } else if (atBottom.current) node.scrollTop = node.scrollHeight;
      atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    } else if (previousId.current) filterInput.current?.focus({ preventScroll: true });
    previousId.current = active?.id ?? null;
  }, [active?.id, active?.messages.length, text, isShown]);
  useLayoutEffect(() => {
    if (!isShown || !activeMessageId) return;
    const node = Array.from(messages.current?.querySelectorAll<HTMLElement>('[data-selection-id]') ?? []).find(node => node.dataset.selectionId === activeSelectionId)
      ?? Array.from(messages.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(node => node.dataset.messageId === activeMessageId);
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeSelectionId, activeMessageId, active?.id, isShown, messageVisit]);
  useLayoutEffect(() => {
    if (!isShown || !messageJump || handledJump.current === messageJump.sequence) return;
    const node = Array.from(messages.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(node => node.dataset.messageId === messageJump.id);
    if (!node) return;
    const frame = requestAnimationFrame(() => {
      handledJump.current = messageJump.sequence;
      node.scrollIntoView({ block: 'center' }); node.focus({ preventScroll: true });
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) node.animate([{ backgroundColor: 'oklch(0.75 0.18 280 / 0.2)' }, { backgroundColor: 'transparent' }], { duration: 800 });
    });
    return () => cancelAnimationFrame(frame);
  }, [messageJump, active?.id, isShown]);
  async function newConversation() {
    if (createBusy.current || !documentId) return;
    createBusy.current = true;
    setCreating(true);
    creatingId.current ??= crypto.randomUUID();
    try {
      const thread = await api<Thread>('/api/threads', { id: creatingId.current, documentId });
      creatingId.current = null;
      setFilter('unresolved');
      setError('');
      onCreated(thread);
      onOpen(thread.id);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      createBusy.current = false;
      setCreating(false);
    }
  }
  async function leaveConversation() {
    if (!active || isLeaving) return;
    // Pending submissions retain their draft until accepted; don't discard them.
    if (active.messages.length || (drafts.get(active.id)?.text.trim() || drafts.get(active.id)?.quote || drafts.get(active.id)?.messageQuote)) {
      onOpen(null);
      return;
    }
    setLeaving(true);
    try {
      const result = await api<{ isDeleted: boolean }>(`/api/threads/${active.id}`, undefined, 'DELETE');
      if (result.isDeleted) {
        drafts.remove(active.id);
        positions.current.delete(active.id);
      }
      setError('');
      if (!previousId.current || previousId.current === active.id) onOpen(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLeaving(false);
    }
  }
  const problems = new Set(
    active
      ? requests
          .filter(
            (request) =>
              request.threadId === active.id && (request.status === 'uncertain' || request.status === 'failed'),
          )
          .map((request) => request.status)
      : [],
  );
  return (
    <aside className="sidebar" id="conversation-sidebar" hidden={!isShown} aria-label="Conversations">
      <div className="sidebar-header">
        {active ? (
          <div className="thread-header">
            <button
              id="conversation-back"
              ref={back}
              className="back-button"
              aria-label="Threads"
              title="Back to threads"
              disabled={isLeaving}
              onClick={() => {
                void leaveConversation();
              }}
            >
              <Icon name="back" />
            </button>
            <TitleForm key={active.id} id={active.id} title={active.title ?? 'Unnamed'} kind="thread" />
            <DropdownMenu>
              <DropdownMenuTrigger className="back-button" aria-label="Thread actions"><Icon name="more" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="thread-filter-menu">
                <DropdownMenuItem onClick={async () => {
                  try { await api(`/api/threads/${active.id}/selections`, { isVisible: true }); setError(''); }
                  catch (reason) { setError(errorText(reason)); }
                }}>Show all selections</DropdownMenuItem>
                <DropdownMenuItem onClick={async () => {
                  try { await api(`/api/threads/${active.id}/selections`, { isVisible: false }); setError(''); }
                  catch (reason) { setError(errorText(reason)); }
                }}>Hide all selections</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              className={`resolve-button${active.isResolved ? ' is-resolved' : ''}`}
              aria-label={active.isResolved ? 'Reopen thread' : 'Resolve thread'}
              title={active.isResolved ? 'Reopen thread' : 'Resolve thread'}
              onClick={async () => {
                try {
                  await api(`/api/threads/${active.id}/resolution`, { isResolved: !active.isResolved });
                  setError('');
                  if (!active.isResolved) {
                    setFilter('unresolved');
                    onOpen(null);
                  }
                } catch (reason) {
                  setError(errorText(reason));
                }
              }}
            >
              <Icon name="check" />
            </button>
          </div>
        ) : (
          <div className="list-header">
            <input className="thread-search" type="search" aria-label="Search threads" placeholder="Search threads" value={search} onChange={event => setSearch(event.target.value)} />
            <DropdownMenu>
              <DropdownMenuTrigger ref={filterInput} className="thread-filter" aria-label="Thread status">
                {filter === 'all' ? 'All' : filter === 'resolved' ? 'Resolved' : 'Unresolved'}<Icon name="chevron" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="thread-filter-menu">
                <DropdownMenuRadioGroup value={filter} onValueChange={value => setFilter(value)}>
                  <DropdownMenuRadioItem closeOnClick value="unresolved">Unresolved</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem closeOnClick value="resolved">Resolved</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem closeOnClick value="all">All</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="count">{visible.length}</span>
            <button
              className="new-button"
              aria-label="New conversation"
              title="New conversation"
              disabled={creating || !documentId}
              onClick={() => {
                void newConversation();
              }}
            >
              <Icon name="plus" />
            </button>
          </div>
        )}
      </div>
      {active && <PinnedMessages key={active.id} threadId={active.id} messages={active.messages} onOpen={onOpenPin} onGoToMessage={onGoToMessage} />}
      {error && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}
      {active ? (
        <section className="sidebar-view" id="threads" data-active-thread={active.id} aria-label="Thread conversation">
          <div
            className="messages"
            ref={messages}
            role="log"
            aria-label="Conversation messages"
            onScroll={(event) => {
              const node = event.currentTarget;
              positions.current.set(active.id, node.scrollTop);
              atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
            }}
          >
            {!active.messages.length && (
              <div className="empty-conversation">
                <Icon name="chat" />
                <h3>Start a conversation</h3>
                <p>Ask a question about this document.</p>
              </div>
            )}
            {active.messages.map((message) => {
              const status = requestStatuses.get(message.requestId);
              const isLatest = latestMessages.get(message.requestId) === message.id;
              const hasStreamedReply = stream?.requestId === message.requestId && !!stream.text;
              return (
                <div className={`message ${message.role}`} key={message.id} tabIndex={-1} data-message-id={message.id} data-active={message.id === activeMessageId || undefined}>
                  <div className="message-content">
                    <MessageContent message={message} documentId={documentId} threadId={active.id} activeSelectionId={activeSelectionId} passageChanged={passageChanged} showPassage={showPassage} showOriginal={showOriginal} onQuoteMessage={onQuoteMessage} onGoToMessage={onGoToMessage} />
                    <MessageActions message={message} threadId={active.id} onPinned={() => onOpenPin(message.id)} />
                  </div>
                  {isLatest && !hasStreamedReply && (status === 'queued' || status === 'claimed' || status === 'stopped') && (
                    <div className="message-status" role="status">
                      {status === 'stopped' ? 'Stopped' : status === 'queued' ? 'Queued' : 'Working…'}
                    </div>
                  )}
                </div>
              );
            })}
            {text && (
              <div className="message agent">
                <MarkdownDocument
                  markdown={text}
                  documentId={documentId}
                  anchorPrefix={`message-${stream?.requestId}-agent-`}
                />
              </div>
            )}
            {!!problems.size && (
              <p className="request-status" role="alert">
                {[...problems]
                  .map((status) =>
                    status === 'uncertain'
                      ? 'Interrupted request; agent must check before retrying.'
                      : 'Request failed.',
                  )
                  .join(' ')}
              </p>
            )}
            {stream?.threadId === active.id && stream.error && <p role="alert">{stream.error}</p>}
          </div>
          <QuestionForm
            key={active.id}
            documentId={documentId}
            threadId={active.id}
            drafts={drafts}
            draftKey={active.id}
            stream={stream}
            quote={drafts.get(active.id)?.quote}
            messageQuote={drafts.get(active.id)?.messageQuote}
            onRemoveSelection={onRemoveSelection}
            disabled={isLeaving}
            onSent={(request) => {
              onMessageSent(request);
              if (previousId.current === active.id) {
                setFilter('unresolved');
                atBottom.current = true;
                if (messages.current) messages.current.scrollTop = messages.current.scrollHeight;
              }
            }}
          />
        </section>
      ) : (
        <div className="thread-list" aria-label="Threads">
          {visible.map((thread) => {
            const match = matches.get(thread.id);
            return <button className="thread-row" data-thread-id={thread.id} key={thread.id} onClick={() => onOpen(thread.id)}>
              <span className="thread-icon" aria-hidden="true"><Icon name="chat" /></span>
              <span className="thread-main">
                <span className="row-top">
                  <span className="thread-title">{thread.title ?? 'Unnamed'}</span>
                  <time className="time" dateTime={new Date(activity(thread)).toISOString()}>
                    {age(activity(thread))}
                  </time>
                </span>
                <span className="preview-line">
                  {thread.messages.some((message) => message.role === 'agent') &&
                    readReplies[thread.id] !==
                      thread.messages.filter((message) => message.role === 'agent').at(-1)?.id && (
                      <span className="unread-dot" role="img" aria-label="Unread reply" title="Unread reply" />
                    )}
                  {inProgress.has(thread.id) ? (
                    <span className="status-spinner" role="img" aria-label="In progress" title="In progress" />
                  ) : queuedThreads.has(thread.id) ? (
                    <span className="queued-indicator" role="img" aria-label="Queued" title="Queued">
                      <Icon name="clock" />
                    </span>
                  ) : null}
                  <span className="thread-preview">
                    {match ? <>{match.before}<mark>{match.match}</mark>{match.after}</> : thread.messages.at(-1)?.text ?? 'Start a conversation about this document.'}
                  </span>
                </span>
                {(drafts.get(thread.id)?.text || drafts.get(thread.id)?.quote || drafts.get(thread.id)?.messageQuote) && <span className="row-tag">Draft</span>}
              </span>
            </button>;
          })}
          {!visible.length && <p className="empty-list">{query ? 'No matching threads.' : filter === 'all' ? 'No threads.' : `No ${filter} threads.`}</p>}
        </div>
      )}
    </aside>
  );
}

export type MessageContentProps = {
  message: Message; documentId: string; threadId: string; activeSelectionId: string | null;
  passageChanged: (quote: Quote) => boolean; showPassage: (selection: SavedSelection) => void; showOriginal: (id: string) => void;
  onQuoteMessage: (quote: MessageQuote) => void; onGoToMessage: (id: string) => void;
};
export function MessageContent({ message, documentId, threadId, activeSelectionId, passageChanged, showPassage, showOriginal, onQuoteMessage, onGoToMessage, prefix = 'message' }: MessageContentProps & { prefix?: string }) {
  function capture(root: HTMLElement) {
    const selected = window.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed) return;
    const range = selected.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || [range.startContainer, range.endContainer].some(node => node.parentElement?.closest(excludedSelection))) return;
    const exact = selectionText(range.cloneContents());
    if (exact.trim()) onQuoteMessage({ threadId, messageId: message.id, exact });
  }
  return <>
    {message.messageQuote && <div className="message-selection message-quote quote">
      <span className="selection-badge text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">quote</span>
      <button aria-label="Go to quoted message" onClick={() => onGoToMessage(message.messageQuote!.messageId)}><span className="quote-excerpt text-[10px] text-muted-foreground/70 border-l border-border pl-2 mb-1.5" title={message.messageQuote.exact}>{message.messageQuote.exact}</span><span className="passage-arrow"><Icon name="arrowUpRight" /></span></button>
    </div>}
    {message.selections?.map(selection => <MessageSelection key={selection.id} documentId={documentId} messageId={message.id} threadId={threadId} selection={selection} isActive={selection.id === activeSelectionId} isChanged={passageChanged(selection.quote)} showPassage={() => showPassage(selection)} showOriginal={() => showOriginal(selection.id)} />)}
    <div className="message-bubble" onMouseUp={event => capture(event.currentTarget)} onTouchEnd={event => capture(event.currentTarget)} onKeyUp={event => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) capture(event.currentTarget); }}><MarkdownDocument markdown={message.text} documentId={documentId} anchorPrefix={`${prefix}-${message.id}-`} onSelectionLink={slug => {
      const selection = message.selections?.find(selection => selection.slug === slug);
      if (!selection) return false;
      if (passageChanged(selection.quote)) showOriginal(selection.id); else showPassage(selection);
      return true;
    }} /></div>
  </>;
}

function MessageActions({ message, threadId, onPinned }: { message: Message; threadId: string; onPinned: () => void }) {
  const { copyFormat } = useMessageSettings();
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); } }, [copied]);
  return <>
    <div className="message-actions">
      <button aria-label="Copy message" title={copied ? 'Copied' : 'Copy message'} onClick={async () => {
        try { await copyMessage(message.text, copyFormat); setCopied(true); setError(''); } catch (reason) { setError(errorText(reason)); }
      }}><Icon name={copied ? 'check' : 'copy'} /></button>
      <button aria-label={message.isPinned ? 'Unpin message' : 'Pin message'} title={message.isPinned ? 'Unpin message' : 'Pin message'} aria-pressed={!!message.isPinned} disabled={saving} onClick={async () => {
        setSaving(true);
        try { await api(`/api/threads/${threadId}/messages/${encodeURIComponent(message.id)}/pin`, { isPinned: !message.isPinned }); setError(''); if (!message.isPinned) onPinned(); }
        catch (reason) { setError(errorText(reason)); }
        finally { setSaving(false); }
      }}><Icon name="pin" /></button>
    </div>
    {copied && <span className="sr-only" role="status">Message copied</span>}
    {error && <p role="alert">{error}</p>}
  </>;
}

export function PinSymbol({ style }: { style?: PinStyle }) {
  const symbol = style?.symbol ?? 'pin';
  return <span className="pin-symbol" data-color={style?.color ?? 'default'} aria-hidden="true">{isPinIcon(symbol) ? <Icon name={symbol} /> : symbol}</span>;
}

function PinMenu({ message, threadId, onGoToMessage }: { message: Message; threadId: string; onGoToMessage: (id: string) => void }) {
  const [category, setCategory] = useState('icons'), [saving, setSaving] = useState(false), [error, setError] = useState(''), [open, setOpen] = useState(false);
  const navigating = useRef(false);
  const [style, setStyle] = useState<PinStyle>(message.pinStyle ?? { symbol: 'pin', color: 'default' });
  useEffect(() => setStyle(message.pinStyle ?? { symbol: 'pin', color: 'default' }), [message.pinStyle]);
  async function save(pinStyle: PinStyle, isPinned = true) {
    if (saving) return;
    setSaving(true);
    try { await api(`/api/threads/${threadId}/messages/${encodeURIComponent(message.id)}/pin`, { isPinned, pinStyle }); setStyle(pinStyle); setError(''); }
    catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  }
  const symbols = category === 'icons' ? pinIcons : (category === 'letters' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '0123456789').split('');
  return <Popover open={open} onOpenChange={value => { if (value) navigating.current = false; setOpen(value); }}>
    <PopoverTrigger className="pin-options" aria-label="Pin options" title="Pin options"><PinSymbol style={style} /></PopoverTrigger>
    <PopoverContent className="pin-menu" align="start" role="dialog" aria-label="Pin options" finalFocus={() => !navigating.current} onKeyDown={event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || !/^[a-z0-9]$/i.test(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      setCategory(/^[0-9]$/.test(event.key) ? 'numbers' : 'letters');
      void save({ ...style, symbol: event.key.toUpperCase() });
    }}>
      <div className="pin-categories" role="group" aria-label="Symbol type">{['icons', 'letters', 'numbers'].map(value => <button key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
      <div className="pin-symbol-grid" role="group" aria-label="Pin symbol">{symbols.map(symbol => <button key={symbol} aria-label={symbol[0].toUpperCase() + symbol.slice(1)} title={symbol[0].toUpperCase() + symbol.slice(1)} aria-pressed={style.symbol === symbol} disabled={saving} onClick={() => { void save({ ...style, symbol }); }}><PinSymbol style={{ ...style, symbol }} /></button>)}</div>
      <div className="pin-colors" role="group" aria-label="Pin color">{pinColors.map(color => <button key={color} aria-label={color[0].toUpperCase() + color.slice(1)} title={color[0].toUpperCase() + color.slice(1)} aria-pressed={style.color === color} disabled={saving} onClick={() => { void save({ ...style, color }); }}><span className="pin-color" data-color={color} /></button>)}</div>
      {error && <p role="alert">{error}</p>}
      <button className="pin-action" onClick={() => { navigating.current = true; setOpen(false); onGoToMessage(message.id); }}><Icon name="arrowUpRight" />Go to message</button>
      <button className="pin-action unpin-action" disabled={saving} onClick={() => { void save(style, false); }}><Icon name="pin" />Unpin</button>
    </PopoverContent>
  </Popover>;
}

function PinnedMessages({ messages, threadId, onOpen, onGoToMessage }: { messages: Message[]; threadId: string; onOpen: (id: string) => void; onGoToMessage: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const pins = messages.filter(message => message.isPinned);
  if (!pins.length) return null;
  return <nav className="pinned-messages" aria-label="Pinned messages">
    {(pins.length > 3 && !expanded ? pins.slice(0, 2) : pins).map(message => <div className="pinned-message-row" key={message.id}><PinMenu message={message} threadId={threadId} onGoToMessage={onGoToMessage} /><button className="pinned-message-title" title={messagePreview(message.text)} onClick={() => onOpen(message.id)}><span>{messagePreview(message.text)}</span></button></div>)}
    {pins.length > 3 && <button className="pins-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `${pins.length - 2} more`}<Icon name="chevron" /></button>}
  </nav>;
}

// Selection badge and excerpt adapted from Plannotator DocumentQAPair (MIT).
function MessageSelection({ documentId, threadId, messageId, selection, isActive, isChanged, showPassage, showOriginal }: {
  documentId: string; threadId: string; messageId: string; selection: SavedSelection; isActive: boolean; isChanged: boolean; showPassage: () => void; showOriginal: () => void;
}) {
  const quote = selection.quote;
  const [isSaving, setSaving] = useState(false), [error, setError] = useState('');
  const path = isChanged ? `/api/documents/${documentId}/versions/${encodeURIComponent(quote.version)}` : null;
  const [available, setAvailable] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false; setAvailable(null);
    if (path) void fetch(path, { method: 'HEAD' }).then(response => { if (!stopped && response.ok) setAvailable(path); }).catch(() => {});
    return () => { stopped = true; };
  }, [path]);
  return <div className="message-selection quote" data-selection-message={messageId} data-selection-id={selection.id} data-active={isActive || undefined}>
    <div className="selection-heading">
      <span className="selection-badge text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">{selection.label ?? 'selection'}</span>
      <button className="selection-visibility" aria-label={selection.isVisible ? 'Hide selection' : 'Show selection'} title={selection.isVisible ? 'Hide selection' : 'Show selection'} aria-pressed={selection.isVisible} disabled={isSaving} onClick={async () => {
        setSaving(true);
        try { await api(`/api/threads/${threadId}/selections/${encodeURIComponent(selection.id)}`, { isVisible: !selection.isVisible }); setError(''); }
        catch (reason) { setError(errorText(reason)); }
        finally { setSaving(false); }
      }}>{selection.isVisible ? 'Hide' : 'Show'}</button>
    </div>
    {isChanged ? <span className="quote-excerpt text-[10px] text-muted-foreground/70 border-l border-border pl-2 mb-1.5" title={quote.exact}>{quote.exact}</span> :
      <button aria-label={`Show passage: ${quote.exact}`} onClick={showPassage}><span className="quote-excerpt text-[10px] text-muted-foreground/70 border-l border-border pl-2 mb-1.5" title={quote.exact}>{quote.exact}</span><span className="passage-arrow"><Icon name="arrowUpRight" /></span></button>}
    {isChanged && <div className="passage-context"><span className="changed">Passage changed</span>{path && available === path && <button className="original-link" onClick={showOriginal}>View original document <span className="passage-arrow"><Icon name="arrowUpRight" /></span></button>}</div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
