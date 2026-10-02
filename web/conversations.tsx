import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import type { Quote, RequestRecord, Thread } from '../src/store.ts';
import { api, errorText, type ViewerState } from './api.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';

const paths = {
  back: 'M19 12H5m6-6-6 6 6 6',
  send: 'M12 19V5m-6 6 6-6 6 6',
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
export type QuestionDraft = { text: string; retry: { signature: string; id: string } | null };
export function QuestionForm({
  documentId,
  threadId,
  quote,
  quoteChanged = false,
  onSent,
  floating = false,
  onCancel,
  disabled = false,
  drafts,
  draftKey,
  onSendingChange,
}: {
  documentId: string;
  threadId?: string;
  quote?: Quote;
  quoteChanged?: boolean;
  onSent: (request: RequestRecord) => void;
  floating?: boolean;
  onCancel?: () => void;
  disabled?: boolean;
  drafts: Map<string, QuestionDraft>;
  draftKey: string;
  onSendingChange?: (sending: boolean) => void;
}) {
  const initialDraft = drafts.get(draftKey);
  const [text, setText] = useState(initialDraft?.text ?? ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null),
    sending = useRef(false);
  const retry = useRef(initialDraft?.retry ?? null);
  useLayoutEffect(() => {
    if (floating) input.current?.focus({ preventScroll: true });
  }, [floating]);
  const cancel = () => {
    if (!sending.current) {
      setText('');
      retry.current = null;
      drafts.delete(draftKey);
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
        const body = { documentId, text, ...(threadId ? { threadId } : quote ? { quote } : {}) };
        const signature = JSON.stringify(body);
        if (retry.current?.signature !== signature) retry.current = { signature, id: crypto.randomUUID() };
        const submittedDraft = { text, retry: retry.current };
        drafts.set(draftKey, submittedDraft);
        sending.current = true;
        setBusy(true);
        onSendingChange?.(true);
        try {
          const request = await api<RequestRecord>('/api/questions', { ...body, clientMessageId: retry.current.id });
          setText('');
          retry.current = null;
          // A remounted composer may already hold a newer draft.
          if (drafts.get(draftKey) === submittedDraft) drafts.delete(draftKey);
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
      <div className="composer-box">
        <textarea
          ref={input}
          aria-label={floating ? 'Comment' : 'Message'}
          placeholder="Ask a question or request a change…"
          required
          value={text}
          readOnly={busy || disabled}
          onChange={(event) => {
            setText(event.target.value);
            drafts.set(draftKey, { text: event.target.value, retry: retry.current });
          }}
        />
        <div className="composer-actions">
          <button
            className="send-button"
            aria-label={floating ? 'Send comment' : 'Send message'}
            disabled={disabled || busy || !text.trim()}
          >
            {floating ? 'Send' : <Icon name="send" />}
          </button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function TitleForm({ id, title }: { id: string; title: string }) {
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
            await api(`/api/documents/${id}/title`, { title: pending.value }, 'PATCH');
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
    <div className="document-name">
      <span hidden={draft !== null} title={title}>
        {title}
      </span>
      <button
        ref={pencil}
        className="edit-title"
        hidden={draft !== null}
        aria-label="Edit document name"
        title="Edit document name"
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
            aria-label="Document name"
            maxLength={120}
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
        {state ? (state.owner.agent === 'codex' ? 'Codex' : 'Claude') : 'Agent'}
        <span className="sr-only"> · {label}</span>
        {queued ? ` · ${queued} queued` : ''}
      </span>
    </span>
  );
}

function activity(thread: Thread) {
  return thread.messages.at(-1)?.createdAt ?? thread.createdAt ?? 0;
}
function age(time: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  return minutes < 1
    ? 'now'
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
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
  isShown,
}: {
  documentId: string;
  threads: Thread[];
  activeId: string | null;
  onOpen: (id: string | null) => void;
  onCreated: (thread: Thread) => void;
  requests: RequestRecord[];
  stream: ViewerState['stream'];
  passageChanged: (quote: Quote) => boolean;
  showPassage: (quote: Quote) => void;
  isShown: boolean;
}) {
  const [filter, setFilter] = useState('unresolved'),
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
  const drafts = useRef(new Map<string, QuestionDraft>()),
    positions = useRef(new Map<string, number>());
  const messages = useRef<HTMLDivElement>(null),
    back = useRef<HTMLButtonElement>(null),
    filterInput = useRef<HTMLSelectElement>(null);
  const previousId = useRef<string | null>(null),
    atBottom = useRef(true);
  const active = threads.find((thread) => thread.id === activeId);
  const requestStatuses = new Map(requests.map((request) => [request.id, request.status]));
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
  const visible = threads
    .filter((thread) => thread.isResolved === (filter === 'resolved'))
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
    if (active.messages.length || drafts.current.get(active.id)?.text.trim()) {
      onOpen(null);
      return;
    }
    setLeaving(true);
    try {
      const result = await api<{ isDeleted: boolean }>(`/api/threads/${active.id}`, undefined, 'DELETE');
      if (result.isDeleted) {
        drafts.current.delete(active.id);
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
            <h2 className="conversation-title" title={active.title ?? 'Unnamed'}>
              {active.title ?? 'Unnamed'}
            </h2>
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
            <select
              ref={filterInput}
              aria-label="Thread status"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="unresolved">Unresolved</option>
              <option value="resolved">Resolved</option>
            </select>
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
      {error && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}
      {active ? (
        <section className="sidebar-view" id="threads" data-active-thread={active.id} aria-label="Thread conversation">
          {active.quote && (
            <div className="conversation-heading">
              <blockquote className="quote">
                {passageChanged(active.quote) ? (
                  <>
                    <span className="quote-excerpt" title={active.quote.exact}>
                      {active.quote.exact}
                    </span>
                    <span className="changed">Passage changed</span>
                  </>
                ) : (
                  <button
                    aria-label={`Show passage: ${active.quote.exact}`}
                    onClick={() => active.quote && showPassage(active.quote)}
                  >
                    <span className="quote-excerpt" title={active.quote.exact}>
                      {active.quote.exact}
                    </span>
                    <span className="quote-link" aria-hidden="true">
                      ↗
                    </span>
                  </button>
                )}
              </blockquote>
            </div>
          )}
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
                <Icon name={active.quote ? 'annotation' : 'chat'} />
                <h3>Start a conversation</h3>
                <p>{active.quote ? 'Ask about the selected passage.' : 'Ask a question about this document.'}</p>
              </div>
            )}
            {active.messages.map((message) => {
              const status = message.role === 'user' ? requestStatuses.get(message.requestId) : undefined;
              const hasStreamedReply = stream?.requestId === message.requestId && !!stream.text;
              return (
                <div className={`message ${message.role}`} key={message.id}>
                  <div className="message-bubble">
                    <MarkdownDocument
                      markdown={message.text}
                      documentId={documentId}
                      anchorPrefix={`message-${message.requestId}-${message.role}-`}
                    />
                  </div>
                  {!hasStreamedReply && (status === 'queued' || status === 'claimed') && (
                    <div className="message-status" role="status">
                      {status === 'queued' ? 'Queued' : 'Working…'}
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
            drafts={drafts.current}
            draftKey={active.id}
            disabled={isLeaving}
            onSent={() => {
              if (previousId.current === active.id) {
                atBottom.current = true;
                if (messages.current) messages.current.scrollTop = messages.current.scrollHeight;
              }
            }}
          />
        </section>
      ) : (
        <div className="thread-list" aria-label="Threads">
          {visible.map((thread) => (
            <button className="thread-row" data-thread-id={thread.id} key={thread.id} onClick={() => onOpen(thread.id)}>
              <span
                className={`thread-icon${thread.quote ? ' annotated' : ''}`}
                role="img"
                aria-label={thread.quote ? 'Annotated thread' : 'General thread'}
              >
                <Icon name={thread.quote ? 'annotation' : 'chat'} />
              </span>
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
                    {thread.messages.at(-1)?.text ?? 'Start a conversation about this document.'}
                  </span>
                </span>
                {thread.quote && passageChanged(thread.quote) ? (
                  <span className="row-tag changed">Passage changed</span>
                ) : drafts.current.get(thread.id)?.text ? (
                  <span className="row-tag">Draft</span>
                ) : null}
              </span>
            </button>
          ))}
          {!visible.length && <p className="empty-list">No {filter} threads.</p>}
        </div>
      )}
    </aside>
  );
}
