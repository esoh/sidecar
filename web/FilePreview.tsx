import { useEffect, useId, useState } from 'react';
import { guideLanguageForPath } from '@plannotator/core/guide-format';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { CodeFileData, FilePreviewData } from '../src/files.ts';
import { api, errorText } from './api.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import type { FileQuote } from '../src/quote.ts';
import { excludedSelection, selectionText } from './selection.ts';
import { CodeFileView } from './CodeFileView.tsx';

// Source previews use the same fenced blocks as Plannotator's documents.
function fenced(language: string, text: string) {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}\n`;
}

export type OpenFile = { id: string; path: string; root?: string; kind: 'doc' | 'code'; refusal?: string; revision: number };

export function FilePreview({ documentId, root, path, kind, refusal, revision, onQuoteFile, onRevealFile }: {
  documentId: string; root?: string; onQuoteFile: (quote: FileQuote) => void;
  onRevealFile: (path: string) => void;
} & OpenFile) {
  const anchorPrefix = useId();
  const [preview, setPreview] = useState<FilePreviewData | null>(null),
    [error, setError] = useState(''),
    [isCopied, setCopied] = useState(false);
  useEffect(() => {
    if (refusal) return;
    let stopped = false;
    setPreview(null);
    setError('');
    api<FilePreviewData | CodeFileData>(`/api/files/${kind === 'code' ? 'code' : 'content'}?document=${encodeURIComponent(documentId)}&path=${encodeURIComponent(path)}${root ? `&directory=${encodeURIComponent(root)}` : ''}`)
      .then((loaded) => {
        if (!stopped) setPreview('codeFile' in loaded ? { path: loaded.filepath, text: loaded.contents, renderAs: 'markdown' } : loaded);
      }, (reason) => { if (!stopped) setError(errorText(reason)); });
    return () => { stopped = true; };
  }, [documentId, root, path, kind, refusal, revision]);
  const sourceLanguage = preview && (kind === 'code' || /\.(jsonc?|json5|ya?ml)$/i.test(path))
    ? guideLanguageForPath(path) ?? 'text' : undefined;
  const markdown = preview && (sourceLanguage ? null
    : preview.renderAs === 'markdown' ? preview.text
    : preview.renderAs === 'mermaid' ? fenced('mermaid', preview.text)
    : preview.renderAs === 'graphviz' ? fenced('dot', preview.text) : null);
  function capture(article: HTMLElement) {
    const selected = window.getSelection();
    if (!root || !preview || !selected?.rangeCount || selected.isCollapsed) return;
    const range = selected.getRangeAt(0);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer) || [range.startContainer, range.endContainer].some(node => node.parentElement?.closest(excludedSelection))) return;
    const exact = selectionText(range.cloneContents());
    if (!exact.trim()) return;
    onQuoteFile({ path: `${root.replace(/\/$/, '')}/${preview.path}`, kind, exact });
  }
  if (refusal) return (
    <section className="file-preview" aria-label="File preview">
      <p>{refusal}</p>
      <p className="file-refusal">
        <code>{path}</code>
        <button onClick={async () => { if (await copyTextToClipboard(path)) setCopied(true); else setError('Could not copy path.'); }}>{isCopied ? 'Copied' : 'Copy path'}</button>
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
  return (
    <section className="file-preview" aria-label="File preview">
      <div className="file-preview-path"><button className="file-reveal" title="Show in file browser" aria-label="Show in file browser" onClick={() => root && onRevealFile(`${root.replace(/\/$/, '')}/${path}`)}><code>{path}</code></button><span>Read-only</span></div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !preview ? (
        <p role="status">Loading file…</p>
      ) : sourceLanguage ? (
        <CodeFileView path={path} contents={preview.text} onQuote={quote => root && onQuoteFile({ path: `${root.replace(/\/$/, '')}/${preview.path}`, kind, ...quote })} />
      ) : markdown === null ? (
        // Sidecar's CSP is inherited by srcdoc, so the preview stays static: no scripts, opaque origin.
        <iframe className="file-preview-frame" title={`Preview of ${path}`} sandbox="" srcDoc={preview.text} />
      ) : (
        <article onMouseUp={event => capture(event.currentTarget)} onTouchEnd={event => capture(event.currentTarget)} onKeyUp={event => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) capture(event.currentTarget); }}>
          {/* An empty document ID keeps relative images from resolving against the open document's folder. */}
          <MarkdownDocument markdown={markdown} documentId="" anchorPrefix={`${anchorPrefix}-`} linkBase={root && `${root}/${path}`.replace(/\/[^/]*$/, '')} />
        </article>
      )}
    </section>
  );
}
