import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@plannotator/ui/components/ui/dropdown-menu';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { sortDocuments, sortSessions, sessionTimes, type LibrarySort } from '../src/library-sort.ts';
import { isGateway, viewerBase, viewerPath, libraryPath } from './viewer-path.ts';
import { useEffect, useState } from 'react';
import type { LibraryDocument, LibraryState, LibrarySession } from '../src/library.ts';
import { api, errorText, type ClosedDocument } from './api.ts';
import { confirmCloseDocument } from './close-document.ts';
import { forgetDocument } from './useQuestionDrafts.ts';
import { Icon, age } from './conversations.tsx';
import { AgentSession } from './AgentSession.tsx';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { TextSettings } from './TextSettings.tsx';

type Preview = { markdown: string; title: string };
export function DocumentLibrary() {
  const [library, setLibrary] = useState<LibraryState | null>(null), [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null), [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [closing, setClosing] = useState<string | null>(null);
  const parameters = new URLSearchParams(location.search), key = parameters.get('owner'), id = parameters.get('document');
  const alias = viewerBase().split('/')[2], isAgentList = isGateway && !alias && !key;
  const session = library?.sessions.find(session => session.ownerKey === key || session.ownerAlias === alias);
  const preference = `sidecar.library.${isAgentList ? 'agents' : 'documents'}.sort`;
  const [sort, setSort] = useState<LibrarySort>(() => { try { return localStorage.getItem(preference) === 'activity' ? 'activity' : 'opened'; } catch { return 'opened'; } });
  const sessions = sortSessions(library?.sessions ?? [], sort);
  function chooseSort(value: string) {
    const next = value === 'activity' ? 'activity' : 'opened'; setSort(next);
    try { localStorage.setItem(preference, next); } catch { /* Sorting still works without browser storage. */ }
  }

  async function refresh() {
    setLoading(true); setError(''); setNow(Date.now());
    try {
      setLibrary(await api<LibraryState>('/api/library'));
      if (key && id) {
        const result = await api<Preview>(`/api/library/${encodeURIComponent(key)}/documents/${encodeURIComponent(id)}`);
        setPreview(result); document.title = `${result.title} — Sidecar`;
      } else document.title = isAgentList ? 'Agents — Sidecar' : 'Documents — Sidecar';
    } catch (reason) { setError(errorText(reason)); }
    finally { setLoading(false); }
  }
  async function closeDocument(owner: string, document: LibraryDocument) {
    if (closing || !confirmCloseDocument(document.title)) return;
    setClosing(document.id); setError('');
    try {
      const result = await api<ClosedDocument>(`/api/library/${encodeURIComponent(owner)}/documents/${encodeURIComponent(document.id)}`, undefined, 'DELETE');
      const storageError = forgetDocument(result.documentId, result.threadIds);
      setLibrary(current => current && { ...current, sessions: current.sessions.map(session => session.ownerKey === owner
        ? { ...session, documents: session.documents.filter(item => item.id !== result.documentId) } : session).filter(session => isGateway || session.documents.length) });
      setError(result.cleanupError ?? storageError ?? '');
    } catch (reason) { setError(errorText(reason)); }
    finally { setClosing(null); }
  }
  useEffect(() => {
    void refresh();
    if (key && id) void api(`/api/library/${encodeURIComponent(key)}/documents/${encodeURIComponent(id)}/opened`, {}).catch(reason => setError(errorText(reason)));
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <header className="topbar">
        <a className="brand" href={libraryPath()}><Icon name="logo" />Sidecar</a>
        {session && <AgentSession owner={session.owner} />}
        <div className="library-actions"><button disabled={loading || !!closing} onClick={() => { void refresh(); }}>Refresh</button><TextSettings /></div>
      </header>
      <main className="canvas library-canvas">
        <div className="reading-width">
          {error && <p role="alert">{error}</p>}
          {key && id ? (
            <>
              <p className="library-note"><a href={isGateway && alias ? viewerPath('/') : libraryPath()}>All documents</a> · Read-only preview. Open Sidecar from the original agent to continue the conversation.</p>
              {preview && <article className="document-card w-full bg-card rounded-xl p-5 md:p-8 lg:p-10 xl:p-12 shadow-xl border border-border/50" aria-label="Document">
                <MarkdownDocument markdown={preview.markdown} documentId={id} libraryOwner={key} />
              </article>}
            </>
          ) : (
            <>
              {isGateway && alias && <a className="library-note" href="/">All agents</a>}
              <div className="library-heading"><h1>{isAgentList ? 'Agents' : 'Documents'}</h1>
                <DropdownMenu>
                  <DropdownMenuTrigger className="thread-filter" aria-label={isAgentList ? 'Sort agents' : 'Sort documents'}>{sort === 'opened' ? 'Last opened' : 'Recent conversation activity'}<Icon name="chevron" /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="thread-filter-menu"><DropdownMenuRadioGroup value={sort} onValueChange={chooseSort}>
                    <DropdownMenuRadioItem closeOnClick value="opened">Last opened</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem closeOnClick value="activity">Recent conversation activity</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup></DropdownMenuContent>
                </DropdownMenu>
              </div>
              {isAgentList ? sessions.map(session => <AgentRow key={session.ownerKey} session={session} now={now} onError={setError} />) : sessions.map(session => (
                <section className="library-session" key={session.ownerKey} aria-label={`${session.owner.agent} ${session.owner.sessionId}`}>
                  <header><AgentSession owner={session.owner} /><span className="library-session-id">{session.owner.sessionId.slice(0, 8)}</span></header>
                  {sortDocuments(session.documents, sort).map(document => (
                    <div className="library-document-row" key={document.id}>
                    <a className="library-document" href={session.url
                      ? `${session.url}/?document=${document.id}`
                      : `${isGateway && session.ownerAlias ? `/a/${session.ownerAlias}/` : '/'}?library=1&owner=${encodeURIComponent(session.ownerKey)}&document=${document.id}`}>
                      <span><strong>{document.title}</strong><small title={document.path}>{document.path}</small></span>
                      <span className="library-document-meta"><span>{document.threadCount} {document.threadCount === 1 ? 'thread' : 'threads'} · {session.url ? 'Open' : 'Preview'}</span><span>Last opened {document.lastOpenedAt ? <time dateTime={new Date(document.lastOpenedAt).toISOString()} title={new Date(document.lastOpenedAt).toLocaleString()}>{age(document.lastOpenedAt, now)}{age(document.lastOpenedAt, now) === 'now' ? '' : ' ago'}</time> : '—'}</span></span>
                    </a>
                    <button className="icon-button library-document-close" aria-label={`Close “${document.title}”`} title="Close document" disabled={loading || !!closing} onClick={() => { void closeDocument(session.ownerKey, document); }}>
                      <Icon name="close" />
                    </button>
                    </div>
                  ))}
                  {!session.documents.length && <p>No saved documents.</p>}
                </section>
              ))}
              {library && !library.sessions.length && <p>{isAgentList ? 'No saved agents.' : 'No saved documents.'}</p>}
              {!!library?.unavailable && <p role="alert">{library.unavailable} saved sessions could not be read.</p>}
            </>
          )}
        </div>
      </main>
    </>
  );
}

function AgentRow({ session, now, onError }: { session: LibrarySession; now: number; onError: (error: string) => void }) {
  const [copied, setCopied] = useState(false), times = sessionTimes(session);
  return <section className="library-agent-row library-session">
    <a className="library-document" href={`/a/${session.ownerAlias}/`}>
      <span><strong>{session.owner.agent === 'claude' ? 'Claude' : 'Codex'}</strong><code className="library-session-id">{session.owner.sessionId}</code></span>
      <span className="library-document-meta"><span>{session.documents.length} {session.documents.length === 1 ? 'document' : 'documents'} · {session.url ? 'Running' : 'Stopped'}</span>
        <span>Last opened {times.lastOpenedAt === null ? '—' : `${age(times.lastOpenedAt, now)}${age(times.lastOpenedAt, now) === 'now' ? '' : ' ago'}`}</span></span>
    </a>
    <button className="icon-button" aria-label={copied ? 'Copied session ID' : 'Copy session ID'} title={copied ? 'Copied' : 'Copy session ID'} onClick={async () => {
      if (await copyTextToClipboard(session.owner.sessionId)) setCopied(true); else onError('Could not copy the session ID.');
    }}><Icon name={copied ? 'check' : 'copy'} /></button>
  </section>;
}
