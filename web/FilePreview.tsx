import { useEffect, useId, useMemo, useState } from 'react';
import { guideLanguageForPath } from '@plannotator/core/guide-format';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { CodeFileData, FileDiffData, FilePreviewData } from '../src/files.ts';
import { api, errorText } from './api.ts';
import { viewerPath } from './viewer-path.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import type { FileQuote } from '../src/quote.ts';
import { excludedSelection, selectionText } from './selection.ts';
import { CodeFileView } from './CodeFileView.tsx';
import { CodeDiff } from './CodeDiff.tsx';
import { MarkdownDiff } from './MarkdownDiff.tsx';
import type { FileLineRange } from './links.ts';
import type { Comparison } from './useComparison.ts';

// Source previews use the same fenced blocks as Plannotator's documents.
function fenced(language: string, text: string) {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}\n`;
}

export type OpenFile = { id: string; path: string; root?: string; kind: 'doc' | 'code'; refusal?: string; fragment?: string; lineRange?: FileLineRange; isLineRangeVisible?: boolean; areScriptsEnabled?: boolean; revision: number };

export function FilePreview({ documentId, root, path, kind, refusal, revision, fragment, lineRange, isLineRangeVisible = true, onSetLineRangeVisible, areScriptsEnabled = false, comparison, onQuoteFile, onRevealFile, onSetScripts }: {
  documentId: string; root?: string; comparison: Comparison; onQuoteFile: (quote: FileQuote) => void;
  onSetLineRangeVisible: (visible: boolean) => void;
  onRevealFile: (path: string) => void; onSetScripts: (enabled: boolean) => void;
} & OpenFile) {
  const anchorPrefix = useId();
  const [preview, setPreview] = useState<FilePreviewData | null>(null),
    [error, setError] = useState(''),
    [isCopied, setCopied] = useState(false);
  const absolute = root ? `${root.replace(/\/$/, '')}/${path}` : undefined;
  const { status, mode, base, revision: comparisonRevision } = comparison;
  const change = absolute && status?.available ? status.files[absolute] : undefined;
  const canDiff = !!absolute && !refusal && !!status?.available && (mode === 'uncommitted' || !!base);
  // Line references open current source; otherwise changed files default to their diff.
  const [showDiff, setShowDiff] = useState<boolean | null>(null);
  useEffect(() => { if (lineRange) setShowDiff(false); }, [revision, lineRange]);
  const diffOn = canDiff && (showDiff ?? (!lineRange && !!change));
  const [diff, setDiff] = useState<FileDiffData | null>(null), [diffError, setDiffError] = useState('');
  const isDeleted = change?.status === 'deleted';
  useEffect(() => {
    if (!diffOn || !absolute) return;
    let stopped = false;
    setDiffError('');
    api<FileDiffData>(`/api/files/diff?document=${encodeURIComponent(documentId)}&path=${encodeURIComponent(absolute)}&mode=${mode}${mode === 'base' ? `&base=${encodeURIComponent(base!)}` : ''}`)
      .then(result => { if (!stopped) setDiff(result); }, reason => { if (!stopped) { setDiff(null); setDiffError(errorText(reason)); } });
    return () => { stopped = true; };
  }, [diffOn, documentId, absolute, mode, base, comparisonRevision]);
  useEffect(() => {
    if (refusal || isDeleted) return;
    let stopped = false;
    setPreview(null);
    setError('');
    api<FilePreviewData | CodeFileData>(`/api/files/${kind === 'code' ? 'code' : 'content'}?document=${encodeURIComponent(documentId)}&path=${encodeURIComponent(path)}${root ? `&directory=${encodeURIComponent(root)}` : ''}`)
      .then((loaded) => {
        if (!stopped) setPreview('codeFile' in loaded ? { path: loaded.filepath, text: loaded.contents, renderAs: 'markdown' } : loaded);
      }, (reason) => { if (!stopped) setError(errorText(reason)); });
    return () => { stopped = true; };
  }, [documentId, root, path, kind, refusal, revision, isDeleted]);
  const isSource = !!lineRange || kind === 'code' || /\.(jsonc?|json5|ya?ml)$/i.test(path);
  const lineCount = useMemo(() => preview?.text.split('\n').length ?? 0, [preview?.text]);
  const hasLineRange = !!lineRange && !!preview && !isDeleted && !error && lineRange.end <= lineCount;
  const shownRange = hasLineRange && isLineRangeVisible && !diffOn ? lineRange : undefined;
  const sourceLanguage = preview && isSource ? guideLanguageForPath(path) ?? 'text' : undefined;
  const renderAs = preview?.renderAs ?? (/\.html?$/i.test(path) ? 'html' : /\.mmd$/i.test(path) ? 'mermaid' : /\.(dot|gv)$/i.test(path) ? 'graphviz' : 'markdown');
  const markdown = preview && (sourceLanguage ? null
    : preview.renderAs === 'markdown' ? preview.text
    : preview.renderAs === 'mermaid' ? fenced('mermaid', preview.text)
    : preview.renderAs === 'graphviz' ? fenced('dot', preview.text) : null);
  function capture(article: HTMLElement, event?: { target: EventTarget }) {
    const selected = window.getSelection();
    // Line diffs (Pierre) quote through CodeDiff, never through this text path.
    if (event?.target instanceof Element && event.target.closest('.code-file-view')) return;
    if (!root || !preview || !selected?.rangeCount || selected.isCollapsed) return;
    const range = selected.getRangeAt(0);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer) || [range.startContainer, range.endContainer].some(node => node.parentElement?.closest(excludedSelection))) return;
    const exact = selectionText(range.cloneContents());
    if (!exact.trim()) return;
    onQuoteFile({ path: `${root.replace(/\/$/, '')}/${preview.path}`, kind, exact });
  }
  const asMarkdown = (text: string | null) => text === null ? '' : renderAs === 'mermaid' ? fenced('mermaid', text) : renderAs === 'graphviz' ? fenced('dot', text) : text;
  const quoteLines = (quote: Pick<FileQuote, 'exact' | 'startLine' | 'endLine'>) => absolute && onQuoteFile({ path: absolute, kind, ...quote });
  const diffView = diff && (isSource || renderAs === 'html'
    ? <CodeDiff path={path} old={diff.old} current={diff.current} onQuote={quoteLines} />
    : <article onMouseUp={event => capture(event.currentTarget, event)} onTouchEnd={event => capture(event.currentTarget, event)} onKeyUp={event => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) capture(event.currentTarget); }}>
      <MarkdownDiff old={asMarkdown(diff.old)} current={asMarkdown(diff.current)} anchorPrefix={`${anchorPrefix}-`} linkBase={root && `${root}/${path}`.replace(/\/[^/]*$/, '')}
        source={<CodeDiff path={path} old={diff.old} current={diff.current} onQuote={quoteLines} />} />
    </article>);
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
  const plain = error ? (
    <p role="alert">{error}</p>
  ) : isDeleted ? (
    <p>This file was deleted in the current comparison.</p>
  ) : !preview ? (
    <p role="status">Loading file…</p>
  ) : sourceLanguage ? (
    <CodeFileView path={path} contents={preview.text} lineRange={shownRange} revision={revision} onQuote={quote => root && onQuoteFile({ path: `${root.replace(/\/$/, '')}/${preview.path}`, kind, ...quote })} />
  ) : markdown === null ? (
    // A separate response keeps inline-script permission out of the main viewer's CSP.
    <iframe key={`${areScriptsEnabled}:${revision}:${fragment ?? ''}`} className="file-preview-frame" title={`Preview of ${path}`} sandbox={areScriptsEnabled ? 'allow-scripts' : ''} referrerPolicy="no-referrer"
      src={viewerPath(`/api/files/html?document=${encodeURIComponent(documentId)}&path=${encodeURIComponent(path)}${root ? `&directory=${encodeURIComponent(root)}` : ''}${areScriptsEnabled ? '&scripts=1' : ''}`) + (fragment ?? '')} />
  ) : (
    <article onMouseUp={event => capture(event.currentTarget)} onTouchEnd={event => capture(event.currentTarget)} onKeyUp={event => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) capture(event.currentTarget); }}>
      {/* An empty document ID keeps relative images from resolving against the open document's folder. */}
      <MarkdownDocument markdown={markdown} documentId="" anchorPrefix={`${anchorPrefix}-`} linkBase={root && `${root}/${path}`.replace(/\/[^/]*$/, '')} />
    </article>
  );
  return (
    <section className="file-preview" aria-label="File preview">
      <div className={`file-preview-path${lineRange ? " has-line-reference" : ""}`}>
        <button className="file-reveal" title="Show in file browser" aria-label="Show in file browser" onClick={() => root && onRevealFile(`${root.replace(/\/$/, '')}/${path}`)}><code>{path}</code></button>
        {lineRange && <div className="file-line-reference">
          <code>{lineRange.start === lineRange.end ? `Line ${lineRange.start}` : `Lines ${lineRange.start}–${lineRange.end}`}</code>
          <button className="selection-visibility" aria-label={shownRange ? 'Hide referenced lines' : 'Show referenced lines'} aria-pressed={!!shownRange} disabled={!hasLineRange} onClick={() => { if (!shownRange) setShowDiff(false); onSetLineRangeVisible(!shownRange); }}>{shownRange ? 'Hide' : 'Show'}</button>
        </div>}
        {canDiff && <label className="file-diff-toggle"><input type="checkbox" checked={diffOn} onChange={event => setShowDiff(event.target.checked)} />Show diff</label>}
        {renderAs === 'html' && !isSource && !diffOn && <label className="file-diff-toggle" title="Only enable for trusted HTML. Blocks external resources and viewer access, but scripts can navigate their own frame."><input type="checkbox" checked={areScriptsEnabled} onChange={event => onSetScripts(event.target.checked)} />Run scripts</label>}
        <span>Read-only</span>
      </div>
      {lineRange && preview && !hasLineRange && <p role="status">The referenced lines are outside this file ({lineCount} lines).</p>}
      {!diffOn ? plain : diff ? diffView : diffError ? <><p role="alert">Diff unavailable: {diffError}</p>{plain}</> : <p role="status">Loading diff…</p>}
    </section>
  );
}
