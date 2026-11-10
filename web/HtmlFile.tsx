import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isSelector } from '../src/quote.ts';
import { Icon } from './conversations.tsx';
import { isGateway, viewerBase, viewerPath } from './viewer-path.ts';

export type HtmlFile = { documentId: string; path: string; root?: string; fragment?: string };
const scriptWarning = 'Only enable for trusted HTML. Blocks external resources and viewer access, but scripts can navigate their own frame.';

function fileQuery({ documentId, path, root }: HtmlFile) {
  return new URLSearchParams({ document: documentId, path, ...(root ? { directory: root } : {}) });
}

export function htmlFullPageUrl(file: HtmlFile) {
  return viewerPath(`/?view=html&${fileQuery(file)}`) + (file.fragment ?? '');
}

// Only the full-page view's file; null when the URL names no file or a gateway page lacks an owner-scoped viewer path.
export function readHtmlView(): HtmlFile | null {
  const query = new URLSearchParams(location.search);
  if (query.get('view') !== 'html') return null;
  return { documentId: query.get('document') ?? '', path: query.get('path') ?? '', root: query.get('directory') ?? undefined, fragment: location.hash };
}
export const isHtmlViewValid = (file: HtmlFile) => !!file.documentId && !!file.path && !(isGateway && !viewerBase());

export function HtmlFileFrame({ areScriptsEnabled, revision = 0, bridge = false, ref, ...file }: HtmlFile & { areScriptsEnabled: boolean; revision?: number; bridge?: boolean; ref?: RefObject<HTMLIFrameElement | null> }) {
  // A separate response keeps inline-script permission out of the viewer's CSP.
  return <iframe ref={ref} key={`${areScriptsEnabled}:${revision}:${file.fragment ?? ''}`} className="file-preview-frame" title={`Preview of ${file.path}`}
    sandbox={areScriptsEnabled ? 'allow-scripts' : ''} referrerPolicy="no-referrer"
    src={viewerPath(`/api/files/html?${fileQuery(file)}${areScriptsEnabled ? `&scripts=1${bridge ? '&bridge=1' : ''}` : ''}`) + (file.fragment ?? '')} />;
}

export function RunHtmlScripts({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <label className="file-diff-toggle" title={scriptWarning}><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} />Run scripts</label>;
}

export type BridgeMessage = { type: 'ready' } | { type: 'selection'; exact: string; selector: string } | { type: 'pick'; exact: string; selector: string; fingerprint: string } | { type: 'picker'; on: false } | { type: 'revealed'; ok: boolean };
const isExact = (v: unknown): v is string => typeof v === 'string' && v.length <= 128 * 1024;
// Scripted pages could forge these; Run scripts is the trusted opt-in and the parent supplies the file path itself.
export function useHtmlBridge(frame: RefObject<HTMLIFrameElement | null>, onMessage: (message: BridgeMessage) => void) {
  const latest = useRef(onMessage);
  latest.current = onMessage;
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!frame.current || event.source !== frame.current.contentWindow || typeof data !== 'object' || data === null || !('sidecar' in data) || data.sidecar !== 'html-bridge' || !('type' in data)) return;
      if (data.type === 'ready') latest.current({ type: 'ready' });
      else if (data.type === 'selection' && 'exact' in data && 'selector' in data && isExact(data.exact) && isSelector(data.selector)) latest.current({ type: 'selection', exact: data.exact, selector: data.selector });
      else if (data.type === 'pick' && 'exact' in data && 'selector' in data && 'fingerprint' in data && isExact(data.exact) && isSelector(data.selector) && typeof data.fingerprint === 'string' && /^\d{1,9}:[0-9a-f]{8}$/.test(data.fingerprint)) latest.current({ type: 'pick', exact: data.exact, selector: data.selector, fingerprint: data.fingerprint });
      else if (data.type === 'picker' && 'on' in data && data.on === false) latest.current({ type: 'picker', on: false });
      else if (data.type === 'revealed' && 'ok' in data && typeof data.ok === 'boolean') latest.current({ type: 'revealed', ok: data.ok });
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [frame]);
  return useCallback((message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ sidecar: 'html-bridge', ...message }, '*'), [frame]);
}

// Checks authorization without downloading the diagram twice; an iframe cannot report its opaque-origin errors.
export function HtmlFileViewer({ file, areScriptsEnabled, bridge, frameRef }: { file: HtmlFile; areScriptsEnabled: boolean; bridge: boolean; frameRef: RefObject<HTMLIFrameElement | null> }) {
  const source = viewerPath(`/api/files/html?${fileQuery(file)}`);
  const [fileStatus, setFileStatus] = useState<'loading' | 'ready' | number>('loading');
  useEffect(() => {
    setFileStatus('loading');
    const controller = new AbortController();
    fetch(source, { method: 'HEAD', signal: controller.signal }).then(response => {
      setFileStatus(response.ok ? 'ready' : response.status);
    }, () => { if (!controller.signal.aborted) setFileStatus(0); });
    return () => controller.abort();
  }, [source]);
  return fileStatus === 'ready' ? <HtmlFileFrame {...file} ref={frameRef} areScriptsEnabled={areScriptsEnabled} bridge={bridge} />
    : fileStatus === 'loading' ? <p role="status">Loading HTML file…</p>
    : <p role="alert">Unable to open this HTML file{fileStatus ? ` (HTTP ${fileStatus})` : ''}. Return to the document to choose an accessible HTML file.</p>;
}

const needScripts = 'Turn on Run scripts to select or pick elements';
export function HtmlControls({ file, areScriptsEnabled, onScripts, isReady, isPicking, onPick, canAsk, onAsk }: {
  file: HtmlFile; areScriptsEnabled: boolean; onScripts: (enabled: boolean) => void; isReady: boolean; isPicking: boolean; onPick: () => void; canAsk: boolean; onAsk: () => void;
}) {
  const title = isReady ? '' : needScripts;
  return <>
    {/* Only the existing owner-scoped viewer route is a return destination; query values never select a host or route. */}
    <a className="html-back sidebar-toggle" href={viewerPath(`/?document=${encodeURIComponent(file.documentId)}`)} aria-label="Back to document" title="Back to document"><Icon name="back" /><span>Back to document</span></a>
    <code className="html-filename" title={file.path}>{file.path.split('/').pop()}</code>
    <RunHtmlScripts enabled={areScriptsEnabled} onChange={onScripts} />
    <button className="sidebar-toggle html-action" aria-label="Pick element" aria-pressed={isPicking} disabled={!isReady} title={title || 'Pick an element to ask about'} onClick={onPick}><Icon name="target" /><span>Pick element</span></button>
    <button className="sidebar-toggle html-action" aria-label="Ask about selection" disabled={!isReady || !canAsk} title={title || (canAsk ? 'Ask about the selected text' : 'Select text in the page first')} onClick={onAsk}><Icon name="comment" /><span>Ask about selection</span></button>
  </>;
}
