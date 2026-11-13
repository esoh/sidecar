import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { guideLanguageForPath } from '@plannotator/core/guide-format';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { FileDiffData } from '../src/files.ts';
import type { WatchedFile } from './useWatchedFiles.ts';
import { api, errorText } from './api.ts';
import { HtmlFileFrame, RunHtmlScripts, htmlFullPageUrl } from './HtmlFile.tsx';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import type { FileQuote } from '../src/quote.ts';
import { excludedSelection } from './selection.ts';
import { rangeToSource } from './source-dom.ts';
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

// A rendered diff is a column of units, each a slice of the current file; the selection maps through the units it touches.
function diffSpan(article: HTMLElement, source: string, range: Range) {
  let start = -1, end = -1;
  for (const unit of article.querySelectorAll<HTMLElement>('.md-diff-unit[data-source-start]')) {
    if (!range.intersectsNode(unit)) continue;
    const from = Number(unit.dataset.sourceStart), part = rangeToSource(unit, source.slice(from, Number(unit.dataset.sourceEnd)), range);
    if (!part) continue;
    if (start < 0) start = from + part.start;
    end = from + part.end;
  }
  return start < 0 ? null : { start, end };
}

export type OpenFile = { id: string; path: string; root?: string; kind: 'doc' | 'code'; refusal?: string; fragment?: string; lineRange?: FileLineRange; isLineRangeVisible?: boolean; areScriptsEnabled?: boolean; revision: number };

export function FilePreview({ documentId, root, path, kind, refusal, revision, fragment, lineRange, isLineRangeVisible = true, onSetLineRangeVisible, areScriptsEnabled = false, comparison, onQuoteFile, onRevealFile, onSetScripts, loaded }: {
  documentId: string; loaded?: WatchedFile; root?: string; comparison: Comparison; onQuoteFile: (quote: FileQuote) => void;
  onSetLineRangeVisible: (visible: boolean) => void;
  onRevealFile: (path: string) => void; onSetScripts: (enabled: boolean) => void;
} & OpenFile) {
  const anchorPrefix = useId();
  // Contents come from the app's poll (useWatchedFiles); the previous text stays up until the new text arrives.
  const preview = loaded?.data ?? null, [copyError, setCopyError] = useState(''), error = loaded?.error ?? copyError;
  const [isCopied, setCopied] = useState(false);
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
  }, [diffOn, documentId, absolute, mode, base, comparisonRevision, loaded?.version]);
  const isSource = !!lineRange || preview?.renderAs === 'text' || kind === 'code' || /\.(jsonc?|json5|ya?ml)$/i.test(path);
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
    // Markdown quotes are exact source slices with their lines; Mermaid and Graphviz quote through their source view.
    const span = preview.renderAs === 'markdown' ? (diffOn ? diffSpan(article, preview.text, range) : rangeToSource(article, preview.text, range)) : null;
    if (!span) return;
    const lineAt = (offset: number) => preview.text.slice(0, offset).split('\n').length;
    onQuoteFile({ path: `${root.replace(/\/$/, '')}/${preview.path}`, kind, exact: preview.text.slice(span.start, span.end), startLine: lineAt(span.start), endLine: lineAt(span.end - 1) });
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
        <button onClick={async () => { if (await copyTextToClipboard(path)) setCopied(true); else setCopyError('Could not copy path.'); }}>{isCopied ? 'Copied' : 'Copy path'}</button>
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
  const plain = isDeleted ? (
    <p>This file was deleted in the current comparison.</p>
  ) : error ? (
    <p role="alert">{error}</p>
  ) : !preview ? (
    <p role="status">Loading file…</p>
  ) : sourceLanguage ? (
    <CodeFileView path={path} contents={preview.text} lineRange={shownRange} revision={revision} onQuote={quote => root && onQuoteFile({ path: `${root.replace(/\/$/, '')}/${preview.path}`, kind, ...quote })} />
  ) : markdown === null ? (
    <HtmlFileFrame documentId={documentId} path={path} root={root} fragment={fragment} revision={`${revision}:${loaded?.version ?? ''}`} areScriptsEnabled={areScriptsEnabled} />
  ) : (
    <article onMouseUp={event => capture(event.currentTarget)} onTouchEnd={event => capture(event.currentTarget)} onKeyUp={event => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) capture(event.currentTarget); }}>
      {/* An empty document ID keeps relative images from resolving against the open document's folder. */}
      <MarkdownDocument markdown={markdown} documentId="" anchorPrefix={`${anchorPrefix}-`} linkBase={root && `${root}/${path}`.replace(/\/[^/]*$/, '')} sourceLines />
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
        {renderAs === 'html' && !isSource && !diffOn && <>
          <RunHtmlScripts enabled={areScriptsEnabled} onChange={onSetScripts} />
          <a className="html-full-page-link" href={htmlFullPageUrl({ documentId, path, root, fragment })} target="_blank" rel="noopener noreferrer">Open full page</a>
        </>}
        <span>Read-only</span>
      </div>
      {lineRange && preview && !hasLineRange && <p role="status">The referenced lines are outside this file ({lineCount} lines).</p>}
      {!diffOn ? plain : diff ? diffView : diffError ? <><p role="alert">Diff unavailable: {diffError}</p>{plain}</> : <p role="status">Loading diff…</p>}
    </section>
  );
}
