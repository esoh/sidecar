import { useEffect, useState } from 'react';
import type { FilePreviewData } from '../src/files.ts';
import { api, errorText } from './api.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';

// Diagram sources render through the same fenced blocks as Plannotator's documents.
function fenced(language: string, text: string) {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}\n`;
}

export function FilePreview({ documentId, path, onReturn }: { documentId: string; path: string; onReturn: () => void }) {
  const [preview, setPreview] = useState<FilePreviewData | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    setPreview(null);
    setError('');
    api<FilePreviewData>(`/api/files/content?document=${encodeURIComponent(documentId)}&path=${encodeURIComponent(path)}`)
      .then((loaded) => { if (!stopped) setPreview(loaded); }, (reason) => { if (!stopped) setError(errorText(reason)); });
    return () => { stopped = true; };
  }, [documentId, path]);
  const markdown = preview && (preview.renderAs === 'markdown' ? preview.text
    : preview.renderAs === 'mermaid' ? fenced('mermaid', preview.text)
    : preview.renderAs === 'graphviz' ? fenced('dot', preview.text) : null);
  return (
    <section className="original-document file-preview" aria-label="File preview">
      <div className="original-banner">
        <span>Previewing <code>{path}</code> · Read-only</span>
        <button onClick={onReturn}>Back to document</button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !preview ? (
        <p role="status">Loading file…</p>
      ) : markdown === null ? (
        // Sidecar's CSP is inherited by srcdoc, so the preview stays static: no scripts, opaque origin.
        <iframe className="file-preview-frame" title={`Preview of ${path}`} sandbox="" srcDoc={preview.text} />
      ) : (
        <article className="document-card w-full bg-card rounded-xl p-5 md:p-8 lg:p-10 xl:p-12 shadow-xl border border-border/50">
          {/* An empty document ID keeps relative images from resolving against the open document's folder. */}
          <MarkdownDocument markdown={markdown} documentId="" anchorPrefix="file-preview-" />
        </article>
      )}
    </section>
  );
}
