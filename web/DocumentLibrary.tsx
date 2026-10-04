import { useEffect, useState } from 'react';
import type { LibraryDocument, LibraryState } from '../src/library.ts';
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
  const session = library?.sessions.find(session => session.ownerKey === key);
  async function refresh() {
    setLoading(true); setError(''); setNow(Date.now());
    try {
      setLibrary(await api<LibraryState>('/api/library'));
      if (key && id) {
        const result = await api<Preview>(`/api/library/${encodeURIComponent(key)}/documents/${encodeURIComponent(id)}`);
        setPreview(result); document.title = `${result.title} — Sidecar`;
      } else document.title = 'Documents — Sidecar';
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
        ? { ...session, documents: session.documents.filter(item => item.id !== result.documentId) } : session).filter(session => session.documents.length) });
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
        <a className="brand" href="/?library=1"><Icon name="logo" />Sidecar</a>
        {session && <AgentSession owner={session.owner} />}
        <div className="library-actions"><button disabled={loading || !!closing} onClick={() => { void refresh(); }}>Refresh</button><TextSettings /></div>
      </header>
      <main className="canvas library-canvas">
        <div className="reading-width">
          {error && <p role="alert">{error}</p>}
          {key && id ? (
            <>
              <p className="library-note"><a href="/?library=1">All documents</a> · Read-only preview. Open Sidecar from the original agent to continue the conversation.</p>
              {preview && <article className="document-card w-full bg-card rounded-xl p-5 md:p-8 lg:p-10 xl:p-12 shadow-xl border border-border/50" aria-label="Document">
                <MarkdownDocument markdown={preview.markdown} documentId={id} libraryOwner={key} />
              </article>}
            </>
          ) : (
            <>
              <h1>Documents</h1>
              {library?.sessions.map(session => (
                <section className="library-session" key={session.ownerKey} aria-label={`${session.owner.agent} ${session.owner.sessionId}`}>
                  <header><AgentSession owner={session.owner} /><span className="library-session-id">{session.owner.sessionId.slice(0, 8)}</span></header>
                  {session.documents.map(document => (
                    <div className="library-document-row" key={document.id}>
                    <a className="library-document" href={session.url
                      ? `${session.url}/?document=${document.id}`
                      : `/?library=1&owner=${encodeURIComponent(session.ownerKey)}&document=${document.id}`}>
                      <span><strong>{document.title}</strong><small title={document.path}>{document.path}</small></span>
                      <span className="library-document-meta"><span>{document.threadCount} {document.threadCount === 1 ? 'thread' : 'threads'} · {session.url ? 'Open' : 'Preview'}</span><span>Last opened {document.lastOpenedAt ? <time dateTime={new Date(document.lastOpenedAt).toISOString()} title={new Date(document.lastOpenedAt).toLocaleString()}>{age(document.lastOpenedAt, now)}{age(document.lastOpenedAt, now) === 'now' ? '' : ' ago'}</time> : '—'}</span></span>
                    </a>
                    <button className="icon-button library-document-close" aria-label={`Close “${document.title}”`} title="Close document" disabled={loading || !!closing} onClick={() => { void closeDocument(session.ownerKey, document); }}>
                      <Icon name="close" />
                    </button>
                    </div>
                  ))}
                </section>
              ))}
              {library && !library.sessions.length && <p>No saved documents.</p>}
              {!!library?.unavailable && <p role="alert">{library.unavailable} saved sessions could not be read.</p>}
            </>
          )}
        </div>
      </main>
    </>
  );
}
