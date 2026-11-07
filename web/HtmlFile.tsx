import { useEffect, useState } from 'react';
import { isGateway, viewerBase, viewerPath } from './viewer-path.ts';

type HtmlFile = { documentId: string; path: string; root?: string; fragment?: string };
const scriptWarning = 'Only enable for trusted HTML. Blocks external resources and viewer access, but scripts can navigate their own frame.';

function fileQuery({ documentId, path, root }: HtmlFile) {
  return new URLSearchParams({ document: documentId, path, ...(root ? { directory: root } : {}) });
}

export function htmlFullPageUrl(file: HtmlFile) {
  return viewerPath(`/?view=html&${fileQuery(file)}`) + (file.fragment ?? '');
}

export function HtmlFileFrame({ areScriptsEnabled, revision = 0, ...file }: HtmlFile & { areScriptsEnabled: boolean; revision?: number }) {
  // A separate response keeps inline-script permission out of the viewer's CSP.
  return <iframe key={`${areScriptsEnabled}:${revision}:${file.fragment ?? ''}`} className="file-preview-frame" title={`Preview of ${file.path}`}
    sandbox={areScriptsEnabled ? 'allow-scripts' : ''} referrerPolicy="no-referrer"
    src={viewerPath(`/api/files/html?${fileQuery(file)}${areScriptsEnabled ? '&scripts=1' : ''}`) + (file.fragment ?? '')} />;
}

export function RunHtmlScripts({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <label className="file-diff-toggle" title={scriptWarning}><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} />Run scripts</label>;
}

export function HtmlFilePage() {
  const query = new URLSearchParams(location.search);
  const documentId = query.get('document') ?? '', path = query.get('path') ?? '';
  const [areScriptsEnabled, setScriptsEnabled] = useState(false);
  const file = { documentId, path, root: query.get('directory') ?? undefined, fragment: location.hash };
  const source = viewerPath(`/api/files/html?${fileQuery(file)}`);
  const isValid = !!documentId && !!path && !(isGateway && !viewerBase());
  const [fileStatus, setFileStatus] = useState<'loading' | 'ready' | number>('loading');
  useEffect(() => {
    if (!isValid) return;
    const controller = new AbortController();
    // Check authorization without downloading the diagram twice; an iframe cannot report its opaque-origin errors.
    fetch(source, { method: 'HEAD', signal: controller.signal }).then(response => {
      setFileStatus(response.ok ? 'ready' : response.status);
    }, () => { if (!controller.signal.aborted) setFileStatus(0); });
    return () => controller.abort();
  }, [source, isValid]);
  useEffect(() => { document.title = `${path.split('/').pop() || 'HTML file'} — Sidecar`; }, [path]);
  // Only the existing owner-scoped viewer route is a return destination; query values never select a host or route.
  if (!isValid) return <p role="alert">Open this page with a document and file from its Sidecar viewer.</p>;
  return <main className="html-file-page" aria-label="HTML file">
    <header>
      <a href={viewerPath(`/?document=${encodeURIComponent(documentId)}`)}>Back to document</a>
      <code title={path}>{path.split('/').pop()}</code>
      <RunHtmlScripts enabled={areScriptsEnabled} onChange={setScriptsEnabled} />
    </header>
    {fileStatus === 'ready' ? <HtmlFileFrame {...file} areScriptsEnabled={areScriptsEnabled} />
      : fileStatus === 'loading' ? <p role="status">Loading HTML file…</p>
      : <p role="alert">Unable to open this HTML file{fileStatus ? ` (HTTP ${fileStatus})` : ''}. Return to the document to choose an accessible HTML file.</p>}
  </main>;
}
