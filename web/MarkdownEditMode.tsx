import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { MarkdownEditor, type MarkdownEditorHandle } from '@plannotator/ui/components/MarkdownEditor';
import { errorText, saveSource } from './api.ts';
import type { FileQuote } from '../src/quote.ts';
import { locateFileQuote } from './edit-quotes.ts';
import { applyExternalText, quoteMarks, scrollToLine, selectionQuote, setQuoteMarks, topVisibleLine, viewCapture } from './editor-view.ts';

export type EditModeHandle = {
  isDirty(): boolean;
  save(): Promise<boolean>;
  /** Resolves true when edit mode was left (clean, or Save/Discard chosen) and false on Cancel. */
  requestExit(): Promise<boolean>;
  revealLines(start: number, end: number): void;
};
const CHANGED = 'The document changed on disk. Review it again.';
type Choice = 'save' | 'discard' | 'cancel';

export function MarkdownEditMode({ documentId, path, markdown, version, diskMarkdown, diskVersion, startLine, handleRef, quotes, onSelect, onOpenQuote, onExit, onError, onStatus }: {
  documentId: string; path: string; markdown: string; version: string;
  /** The live file content from the app; it changes whenever the file changes on disk. */
  diskMarkdown: string; diskVersion: string; startLine: number;
  handleRef: MutableRefObject<EditModeHandle | null>;
  /** Quotes of this file to paint; `id` is what a click on the mark reports. */
  quotes: Array<{ id: string; quote: FileQuote }>;
  /** A finished selection (or null once there is none). */
  onSelect: (selection: ReturnType<typeof selectionQuote>) => void;
  onOpenQuote: (id: string) => void;
  onExit: (line: number) => void; onError: (message: string) => void;
  /** Dirty and saving state, shown by the app header's controls. */
  onStatus: (status: { dirty: boolean; saving: boolean }) => void;
}) {
  const [mountKey, setMountKey] = useState(0), [seed, setSeed] = useState(markdown);
  const [banner, setBanner] = useState(false), [canOverride, setCanOverride] = useState(false);
  const dismissed = useRef(''), disk = useRef({ markdown: diskMarkdown, version: diskVersion });
  disk.current = { markdown: diskMarkdown, version: diskVersion };
  const conflictVersion = useRef('');
  const editor = useRef<MarkdownEditorHandle | null>(null), view = useRef<EditorView | null>(null);
  const synced = useRef(markdown), baseVersion = useRef(version), saving = useRef(false), dirtyNow = useRef(false);
  const [dirty, setDirty] = useState(false), [asking, setAsking] = useState(false), [isSaving, setSaving] = useState(false);
  const choose = useRef<((choice: Choice) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const markDirty = (value: boolean) => { dirtyNow.current = value; setDirty(value); };

  // An empty version means the file is unreadable: keep the edits and wait for it to come back.
  function reconcile() {
    const { markdown: text, version: next } = disk.current;
    if (!next || next === baseVersion.current || saving.current) return;
    if (view.current && (!dirtyNow.current || editor.current?.getMarkdown() === text)) {
      synced.current = text; baseVersion.current = next;
      applyExternalText(view.current, text); markDirty(false); setBanner(false); setCanOverride(false);
    } else if (next !== dismissed.current) setBanner(true);
  }
  const saveWith = useCallback(async (override: boolean) => {
    const text = editor.current?.getMarkdown();
    if (text === undefined || saving.current) return false;
    if (text === synced.current) { markDirty(false); return true; }
    // Save anyway only overrides the change the user saw; a newer one needs a fresh look.
    if (override && conflictVersion.current !== disk.current.version) { conflictVersion.current = disk.current.version; setBanner(true); return false; }
    const startDisk = disk.current.version;
    saving.current = true; setSaving(true);
    try {
      baseVersion.current = (await saveSource(documentId, text, override ? conflictVersion.current : baseVersion.current)).version;
      synced.current = text; setBanner(false); setCanOverride(false);
      markDirty(editor.current?.getMarkdown() !== text);
      saving.current = false;
      // The file moved on while the save was in flight: reconcile it now, the effect skipped it.
      if (disk.current.version !== startDisk && disk.current.version !== baseVersion.current) reconcile();
      return true;
    } catch (reason) {
      if ((reason as { status?: number }).status === 409 && errorText(reason) === CHANGED) { conflictVersion.current = disk.current.version; setBanner(true); setCanOverride(true); }
      else onError(errorText(reason));
      return false;
    }
    finally { saving.current = false; setSaving(false); }
  }, [documentId, onError]);
  const save = useCallback(() => saveWith(false), [saveWith]);
  const reload = () => {
    setSeed(disk.current.markdown); baseVersion.current = disk.current.version; synced.current = disk.current.markdown;
    markDirty(false); setBanner(false); setCanOverride(false); setMountKey(key => key + 1);
  };
  const keepMine = () => { dismissed.current = disk.current.version; setBanner(false); };
  useEffect(reconcile, [diskVersion, diskMarkdown]);
  const leave = useCallback(() => {
    onExit(view.current ? topVisibleLine(view.current) : startLine);
  }, [onExit, startLine]);
  const requestExit = useCallback(async () => {
    if (!dirtyNow.current) { leave(); return true; }
    const choice = await new Promise<Choice>(resolve => { choose.current = resolve; setAsking(true); });
    setAsking(false);
    if (choice === 'cancel' || (choice === 'save' && !await save())) return false;
    dirtyNow.current = false;
    leave();
    return true;
  }, [leave, save]);
  useImperativeHandle(handleRef, () => ({
    isDirty: () => dirtyNow.current, save, requestExit,
    revealLines: start => { if (view.current) scrollToLine(view.current, start); },
  }), [save, requestExit]);
  useEffect(() => () => { handleRef.current = null; }, [handleRef]);

  useEffect(() => { onStatus({ dirty, saving: isSaving }); }, [dirty, isSaving]);
  useEffect(() => () => onStatus({ dirty: false, saving: false }), []);
  useEffect(() => { if (asking) dialog.current?.showModal(); }, [asking]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { if (dirtyNow.current) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const mountId = `${documentId}:${mountKey}`;
  const latest = useRef({ quotes, onSelect, onOpenQuote, path });
  latest.current = { quotes, onSelect, onOpenQuote, path };
  const paint = useCallback(() => {
    const target = view.current;
    if (!target) return;
    const text = target.state.doc.toString();
    const marks = latest.current.quotes.flatMap(({ id, quote }) => { const at = locateFileQuote(text, quote); return at ? [{ ...at, id }] : []; });
    target.dispatch({ effects: setQuoteMarks.of(marks), annotations: Transaction.addToHistory.of(false) });
  }, []);
  const extensions = useMemo(() => [
    viewCapture(view),
    quoteMarks(),
    EditorView.updateListener.of(update => { if (update.docChanged) queueMicrotask(paint); }),
    EditorView.domEventHandlers({
      mouseup: (_, editor) => { latest.current.onSelect(selectionQuote(editor, latest.current.path)); },
      touchend: (_, editor) => { latest.current.onSelect(selectionQuote(editor, latest.current.path)); },
      keyup: (event, editor) => { if (event.key.startsWith('Arrow') || event.key === 'Shift') latest.current.onSelect(selectionQuote(editor, latest.current.path)); },
      click: event => {
        const id = event.target instanceof Element ? event.target.closest<HTMLElement>('.edit-quote')?.dataset.quoteId : undefined;
        if (id) latest.current.onOpenQuote(id);
      },
    }),
    Prec.high(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { void save(); return true; } }])),
  ], [mountId]);
  // Marks follow the threads and a remounted editor; its view appears a frame after mount.
  const quoteKey = JSON.stringify(quotes);
  useEffect(() => {
    let frame = 0, tries = 0;
    const apply = () => { if (view.current) paint(); else if (++tries < 60) frame = requestAnimationFrame(apply); };
    frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [mountId, quoteKey]);
  // Open at the reading position as soon as the engine has created its view.
  useEffect(() => {
    if (startLine <= 1) return;
    let frame = 0, tries = 0;
    const apply = () => {
      if (view.current) scrollToLine(view.current, startLine);
      else if (++tries < 60) frame = requestAnimationFrame(apply);
    };
    frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [mountId]);

  return (
    <div className="markdown-edit-mode">
      {banner && (
        <p className="markdown-edit-banner" role="alert">
          This file changed on disk.{' '}
          <button onClick={reload}>Reload</button>{' '}
          <button onClick={keepMine}>Keep mine</button>
          {canOverride && <>{' '}<button onClick={() => { void saveWith(true); }}>Save anyway</button></>}
        </p>
      )}
      <MarkdownEditor
        markdown={seed}
        documentId={mountId}
        editorHandleRef={editor}
        onMarkdownChange={text => markDirty(text !== synced.current)}
        mode="dark"
        maxWidth={null}
        extensions={extensions}
      />
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
