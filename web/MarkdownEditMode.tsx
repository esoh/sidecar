import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { ChangeSet, Prec, Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { errorText, saveSource } from './api.ts';
import type { Quote } from '../src/store.ts';
import { EditPreview, previewTopLine, scrollPreviewToLine } from './EditPreview.tsx';
import { SourceEditor } from './SourceEditor.tsx';
import { syncScroll } from './scroll-sync.ts';
import { useMessageSettings } from './TextSettings.tsx';
import { applyExternalText, minimalChange, quoteMarks, revealRange, selectionQuote, setQuoteMarks, setTracked, trackedQuote, trackedRange } from './editor-view.ts';
import { freshQuote, locateQuote, sourceQuote } from './selection.ts';
import { rangeToSource } from './source-dom.ts';

export type EditModeHandle = {
  isDirty(): boolean;
  save(): Promise<boolean>;
  /** Formats the Markdown with Prettier (loaded on first use) as one undoable edit; never saves. */
  format(): Promise<void>;
  /** The editor's current text, to keep it when the document disappears. */
  getText(): string;
  /** Resolves true when edit mode was left (clean, or Save/Discard chosen) and false on Cancel. */
  requestExit(): Promise<boolean>;
  /** Scrolls the source pane to a thread quote and marks it; edit mode is never left. */
  revealQuote(id: string): void;
  /** The pending selection's range, mapped through later edits, as a quote of the last saved version (null once its text was edited away). */
  pendingQuote(): Quote | null;
  /** The text last saved and its version: what the server holds, even if more was typed while a save ran. */
  source(): { text: string; version: string };
};
type Choice = 'save' | 'discard' | 'cancel';
type Picked = { quote: Quote; rect: DOMRect } | null;

export function MarkdownEditMode({ documentId, linkBase, markdown, version, diskMarkdown, diskVersion, anchor, handleRef, quotes, onSelect, onOpenQuote, onExit, onError, onStatus }: {
  documentId: string; linkBase?: string; markdown: string; version: string;
  /** The live file content from the app; it changes whenever the file changes on disk. */
  diskMarkdown: string; diskVersion: string;
  /** A source offset to open at (the reading view's top block). */
  anchor: number;
  handleRef: MutableRefObject<EditModeHandle | null>;
  /** Quotes of this document to paint in both panes; `id` is what a click on one reports. */
  quotes: Array<{ id: string; quote: Quote }>;
  /** Returns false when the app kept its earlier selection instead (a comment is being written). */
  onSelect: (selection: Picked) => boolean | void;
  onOpenQuote: (id: string) => void;
  /** `quote` is the pending selection restamped against the saved text (null when discarded or edited away). */
  onExit: (line: number, quote: Quote | null) => void; onError: (message: string) => void;
  /** Dirty and saving state, shown by the app header's controls. */
  onStatus: (status: { dirty: boolean; saving: boolean; formatting: boolean }) => void;
}) {
  const [mountKey, setMountKey] = useState(0), [seed, setSeed] = useState(markdown), [preview, setPreview] = useState(markdown);
  const [banner, setBanner] = useState(false), [canOverride, setCanOverride] = useState(false);
  const { scrollSyncPosition } = useMessageSettings(), scrollSyncRef = useRef(scrollSyncPosition);
  scrollSyncRef.current = scrollSyncPosition;
  const dismissed = useRef(''), disk = useRef({ markdown: diskMarkdown, version: diskVersion });
  disk.current = { markdown: diskMarkdown, version: diskVersion };
  // The disk version a Save anyway overrides, and the app's disk version when the conflict was reported.
  const conflict = useRef({ version: '', seen: '' });
  const view = useRef<EditorView | null>(null), previewRoot = useRef<HTMLElement | null>(null), previewScroller = useRef<HTMLDivElement | null>(null), previewRanges = useRef(new Map<string, Range[]>());
  const synced = useRef(markdown), baseVersion = useRef(version), saving = useRef(false), dirtyNow = useRef(false);
  const [dirty, setDirty] = useState(false), [asking, setAsking] = useState(false), [isSaving, setSaving] = useState(false), [formatting, setFormatting] = useState(false), isFormatting = useRef(false);
  const choose = useRef<((choice: Choice) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), activeId = useRef('');
  const [narrow, setNarrow] = useState(() => innerWidth <= 850), [pane, setPane] = useState<'source' | 'preview'>('source');
  const markDirty = (value: boolean) => { dirtyNow.current = value; setDirty(value); };
  const text = () => view.current?.state.doc.toString() ?? '';

  // An empty version means the file is unreadable: keep the edits and wait for it to come back.
  function reconcile() {
    const { markdown: next, version: nextVersion } = disk.current;
    if (!nextVersion || nextVersion === baseVersion.current || saving.current) return;
    if (view.current && (!dirtyNow.current || text() === next)) {
      synced.current = next; baseVersion.current = nextVersion;
      applyExternalText(view.current, next); markDirty(false); setBanner(false); setCanOverride(false);
    } else if (nextVersion !== dismissed.current) setBanner(true);
  }
  const saveWith = useCallback(async (override: boolean) => {
    const saved = view.current?.state.doc.toString();
    if (saved === undefined || saving.current) return false;
    if (saved === synced.current) { markDirty(false); return true; }
    // Save anyway only overrides the change the user saw; a newer one needs a fresh look.
    if (override && ![conflict.current.version, conflict.current.seen].includes(disk.current.version)) { conflict.current = { version: disk.current.version, seen: disk.current.version }; setBanner(true); return false; }
    const startDisk = disk.current.version;
    saving.current = true; setSaving(true);
    try {
      baseVersion.current = (await saveSource(documentId, saved, override ? conflict.current.version : baseVersion.current)).version;
      synced.current = saved; setBanner(false); setCanOverride(false);
      markDirty(text() !== saved);
      saving.current = false;
      // The file moved on while the save was in flight: reconcile it now, the effect skipped it.
      if (disk.current.version !== startDisk && disk.current.version !== baseVersion.current) reconcile();
      return true;
    } catch (reason) {
      const { status, code, version } = reason as { status?: number; code?: string; version?: string };
      if (status === 409 && code === 'changed') { conflict.current = { version: version || disk.current.version, seen: disk.current.version }; setBanner(true); setCanOverride(true); }
      else onError(errorText(reason));
      return false;
    }
    finally { saving.current = false; setSaving(false); }
  }, [documentId, onError]);
  const save = useCallback(() => saveWith(false), [saveWith]);
  // Prettier is a separate chunk, fetched on the first click; the result replaces the text as a single history step.
  const format = useCallback(async () => {
    const editor = view.current, before = text();
    if (!editor || isFormatting.current || before.includes('\r')) return;
    isFormatting.current = true; setFormatting(true);
    try {
      const [prettier, plugin] = await Promise.all([import('prettier/standalone'), import('prettier/plugins/markdown')]);
      const formatted = await prettier.format(before, { parser: 'markdown', plugins: [plugin] });
      if (view.current !== editor || text() !== before) { onError('The text changed while formatting. Try again.'); return; }
      const change = minimalChange(before, formatted);
      if (change) editor.dispatch({ changes: change, userEvent: 'input.format', scrollIntoView: true });
    } catch (reason) { onError(`Could not format: ${errorText(reason)}`); }
    finally { isFormatting.current = false; setFormatting(false); }
  }, [onError]);
  const reload = () => {
    setSeed(disk.current.markdown); setPreview(disk.current.markdown); baseVersion.current = disk.current.version; synced.current = disk.current.markdown;
    markDirty(false); setBanner(false); setCanOverride(false); setMountKey(key => key + 1);
  };
  const keepMine = () => { dismissed.current = disk.current.version; setBanner(false); };
  useEffect(reconcile, [diskVersion, diskMarkdown]);

  // Done returns the reader to the passage at the top of the preview (it follows the source even while hidden).
  const topLine = () => previewScroller.current && previewRoot.current ? previewTopLine(previewScroller.current, previewRoot.current) : 1;
  // The pending selection survives leaving when its text is still in the saved source (after Discard, the saved text is what remains).
  const leave = useCallback(() => {
    const tracked = view.current ? trackedQuote(view.current.state, baseVersion.current) : null, saved = synced.current;
    let kept = tracked && freshQuote(tracked, saved, baseVersion.current);
    // Edits next to the passage change its context; its text alone, if it occurs once in the saved source, is still that passage.
    if (typeof kept === 'string' && tracked && saved.indexOf(tracked.exact) !== -1 && saved.indexOf(tracked.exact) === saved.lastIndexOf(tracked.exact)) {
      const at = saved.indexOf(tracked.exact);
      kept = sourceQuote(saved, at, at + tracked.exact.length, baseVersion.current);
    }
    onExit(topLine(), typeof kept === 'object' ? kept : null);
  }, [onExit]);
  const requestExit = useCallback(async () => {
    if (!dirtyNow.current) { leave(); return true; }
    const choice = await new Promise<Choice>(resolve => { choose.current = resolve; setAsking(true); });
    setAsking(false);
    if (choice === 'cancel' || (choice === 'save' && !await save())) return false;
    dirtyNow.current = false;
    leave();
    return true;
  }, [leave, save]);

  const latest = useRef({ quotes, onSelect, onOpenQuote });
  latest.current = { quotes, onSelect, onOpenQuote };
  const clean = () => text() === synced.current ? baseVersion.current : undefined;
  const paint = useCallback((target = view.current) => {
    if (!target) return;
    const source = target.state.doc.toString(), at = source === synced.current ? baseVersion.current : undefined;
    const marks = latest.current.quotes.flatMap(({ id, quote }) => { const found = locateQuote(source, quote, at); return found ? [{ from: found.start, to: found.end, id, active: id === activeId.current }] : []; });
    target.dispatch({ effects: setQuoteMarks.of(marks), annotations: Transaction.addToHistory.of(false) });
  }, []);
  const revealQuote = useCallback((id: string) => {
    activeId.current = id; paint();
    const entry = latest.current.quotes.find(item => item.id === id), found = entry && view.current && locateQuote(text(), entry.quote, clean());
    if (found && view.current) revealRange(view.current, found.start, found.end);
    previewRanges.current.get(id)?.[0]?.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  }, [paint]);
  useImperativeHandle(handleRef, () => ({
    isDirty: () => dirtyNow.current, getText: text, save, format, requestExit, revealQuote,
    pendingQuote: () => view.current ? trackedQuote(view.current.state, baseVersion.current) : null,
    source: () => ({ text: synced.current, version: baseVersion.current }),
  }), [save, format, requestExit, revealQuote]);
  useEffect(() => () => { handleRef.current = null; }, [handleRef]);

  useEffect(() => { onStatus({ dirty, saving: isSaving, formatting }); }, [dirty, isSaving, formatting]);
  useEffect(() => () => onStatus({ dirty: false, saving: false, formatting: false }), []);
  useEffect(() => { if (asking) dialog.current?.showModal(); }, [asking]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { if (dirtyNow.current) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const resize = () => setNarrow(innerWidth <= 850);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // A selection in the source pane tracks its range through later edits, so Save & send can restamp it.
  const report = (editor: EditorView) => {
    const picked = selectionQuote(editor, baseVersion.current);
    if (latest.current.onSelect(picked) !== false && picked) editor.dispatch({ effects: setTracked.of({ from: picked.quote.start, to: picked.quote.end, exact: picked.quote.exact }) });
  };
  // The preview shows text up to one debounce old: map its offsets onto the editor's current text.
  const previewRange = (range: Range, rendered: string) => {
    const editor = view.current, root = previewRoot.current, span = root && rangeToSource(root, rendered, range);
    if (!editor || !span) return latest.current.onSelect(null);
    const now = editor.state.doc.toString(), change = minimalChange(rendered, now), changes = change && ChangeSet.of(change, rendered.length);
    const start = changes ? changes.mapPos(span.start, 1) : span.start, end = changes ? changes.mapPos(span.end, -1) : span.end;
    if (!now.slice(start, end).trim()) return latest.current.onSelect(null);
    const quote = sourceQuote(now, start, end, baseVersion.current);
    if (latest.current.onSelect({ quote, rect: range.getBoundingClientRect() }) !== false) editor.dispatch({ effects: setTracked.of({ from: start, to: end, exact: quote.exact }) });
  };
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const typed = () => {
    markDirty(text() !== synced.current);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPreview(text()), 150);
  };

  const mountId = `${documentId}:${mountKey}`;
  const dragging = useRef(false);
  const extensions = useMemo(() => [
    trackedRange,
    quoteMarks(),
    // A new view (first mount or Reload) paints itself.
    ViewPlugin.define(created => { queueMicrotask(() => paint(created)); return {}; }),
    EditorView.updateListener.of(update => {
      if (update.docChanged) queueMicrotask(() => paint());
      // Typing over a selection, Mod-a and the like change what is selected; a pointer drag reports on release.
      // Agent text applied to a clean editor is not the user changing their selection.
      if ((update.docChanged || update.selectionSet) && !dragging.current && !update.transactions.every(tr => tr.annotation(Transaction.remote))) queueMicrotask(() => report(update.view));
    }),
    EditorView.domEventHandlers({
      mousedown: () => {
        dragging.current = true;
        window.addEventListener('mouseup', () => { dragging.current = false; }, { once: true });
      },
      mouseup: (_, editor) => { report(editor); },
      touchend: (_, editor) => { report(editor); },
      keyup: (event, editor) => { if (event.key.startsWith('Arrow') || event.key === 'Shift') report(editor); },
      click: event => {
        const id = event.target instanceof Element ? event.target.closest<HTMLElement>('.edit-quote')?.dataset.quoteId : undefined;
        if (!id) return;
        latest.current.onOpenQuote(id);
        // The opened thread claims focus when it mounts; the click was to edit, so hand it back.
        const refocus = () => view.current?.focus();
        queueMicrotask(refocus); requestAnimationFrame(refocus);
      },
    }),
    Prec.high(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { void save(); return true; } }])),
  ], [mountId]);
  // Marks follow the threads and a remounted editor.
  const quoteKey = JSON.stringify(quotes);
  useEffect(() => { paint(); }, [mountId, quoteKey]);
  // The panes scroll together; the one not shown (narrow) stays laid out and keeps following.
  useEffect(() => view.current && previewScroller.current ? syncScroll(view.current, previewScroller.current, () => scrollSyncRef.current / 100) : undefined, [mountId]);
  // Open at the reading position: the preview takes it and the source follows.
  useEffect(() => {
    if (anchor <= 0) return;
    const frame = requestAnimationFrame(() => {
      if (!view.current) return;
      const line = view.current.state.doc.lineAt(Math.min(anchor, view.current.state.doc.length)).number;
      if (previewScroller.current && previewRoot.current) scrollPreviewToLine(previewScroller.current, previewRoot.current, line);
    });
    return () => cancelAnimationFrame(frame);
  }, [mountId]);

  return (
    <div className="markdown-edit-mode" data-narrow={narrow || undefined}>
      {banner && (
        <p className="markdown-edit-banner" role="alert">
          This file changed on disk.{' '}
          <button onClick={reload}>Reload</button>{' '}
          <button onClick={keepMine}>Keep mine</button>
          {canOverride && <>{' '}<button onClick={() => { void saveWith(true); }}>Save anyway</button></>}
        </p>
      )}
      {narrow && (
        <div className="edit-pane-toggle" role="group" aria-label="Editor pane">
          <button aria-pressed={pane === 'source'} onClick={() => setPane('source')}>Source</button>
          <button aria-pressed={pane === 'preview'} onClick={() => setPane('preview')}>Preview</button>
        </div>
      )}
      <div className="edit-panes">
        <div className="edit-pane" data-hidden={narrow && pane !== 'source' || undefined}>
          <SourceEditor key={mountId} initial={seed} extensions={extensions} onChange={typed} viewRef={view} />
        </div>
        <div className="edit-pane" data-hidden={narrow && pane !== 'preview' || undefined}>
          <EditPreview text={preview} documentId={documentId} linkBase={linkBase} quotes={quotes} version={preview === synced.current ? baseVersion.current : undefined}
            rootRef={previewRoot} scrollRef={previewScroller} rangesRef={previewRanges} onRange={previewRange} onOpenQuote={id => latest.current.onOpenQuote(id)} />
        </div>
      </div>
      {asking && (
        <dialog ref={dialog} className="markdown-edit-leave" aria-label="Unsaved changes"
          onCancel={event => { event.preventDefault(); choose.current?.('cancel'); }}>
          <p>You have unsaved changes.</p>
          <div>
            <button onClick={() => choose.current?.('save')}>Save</button>
            <button onClick={() => choose.current?.('discard')}>Discard</button>
            <button onClick={() => choose.current?.('cancel')}>Cancel</button>
          </div>
        </dialog>
      )}
    </div>
  );
}
