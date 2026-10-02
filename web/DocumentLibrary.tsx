import { useEffect, useState } from 'react';
import type { LibraryState } from '../src/library.ts';
import { api, errorText } from './api.ts';
import { Icon } from './conversations.tsx';
import { AgentSession } from './AgentSession.tsx';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { TextSettings } from './TextSettings.tsx';

type Preview = { markdown: string; title: string };
export function DocumentLibrary() {
  const [library, setLibrary] = useState<LibraryState | null>(null), [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null), [loading, setLoading] = useState(false);
  const parameters = new URLSearchParams(location.search), key = parameters.get('owner'), id = parameters.get('document');
  const session = library?.sessions.find(session => session.ownerKey === key);
  async function refresh() {
    setLoading(true); setError('');
    try {
      setLibrary(await api<LibraryState>('/api/library'));
      if (key && id) {
        const result = await api<Preview>(`/api/library/${encodeURIComponent(key)}/documents/${encodeURIComponent(id)}`);
        setPreview(result); document.title = `${result.title} — Sidecar`;
      } else document.title = 'Documents — Sidecar';
    } catch (reason) { setError(errorText(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    void refresh();
    if (key && id) void api(`/api/library/${encodeURIComponent(key)}/documents/${encodeURIComponent(id)}/opened`, {}).catch(reason => setError(errorText(reason)));
  }, []);
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/?library=1"><Icon name="logo" />Sidecar</a>
        {session && <AgentSession owner={session.owner} />}
        <div className="library-actions"><button disabled={loading} onClick={() => { void refresh(); }}>Refresh</button><TextSettings /></div>
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
                    <a className="library-document" key={document.id} href={session.url
                      ? `${session.url}/?document=${document.id}`
                      : `/?library=1&owner=${encodeURIComponent(session.ownerKey)}&document=${document.id}`}>
                      <span><strong>{document.title}</strong><small title={document.path}>{document.path}</small></span>
                      <span className="library-document-meta"><span>{document.threadCount} {document.threadCount === 1 ? 'thread' : 'threads'} · {session.url ? 'Open' : 'Preview'}</span><span>Last opened {document.lastOpenedAt ? <time dateTime={new Date(document.lastOpenedAt).toISOString()} title={new Date(document.lastOpenedAt).toLocaleString()}>{new Date(document.lastOpenedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time> : '—'}</span></span>
                    </a>
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
